// Proofs as ordered steps: build them with AI from a theorem, or split a written proof into steps, then check
// them in order: (1) a step may only use earlier steps, (2) algebra is verified numerically (latex-math.ts),
// (3) the AI judges whether each step follows from what comes before it. Saved in .texdesk/proofs.json.
import { extractJson, runAi } from './ai-client'
import type { AppHost } from './host'
import type { Job } from './knowledge'
import { AlgebraResult, checkAlgebra, mathOf } from './latex-math'
import { hash } from './prose'

export type Strategy = 'auto' | 'direct' | 'contradiction' | 'contrapositive' | 'induction' | 'cases'
export type StepKind = 'assume' | 'derive' | 'case' | 'base' | 'inductive' | 'conclude'
export type Verdict = 'unchecked' | 'checking' | 'ok' | 'partly' | 'fail'
export type Step = {
  id: string
  kind: StepKind
  claim: string
  justification: string
  uses: string[]
  status: Verdict
  notes: string[]
  algebra?: AlgebraResult
  /** For a proof read from the document: the step's exact text there (for underlines). */
  text?: string
}
export type Proof = {
  statement: string
  hypotheses: { id: string; text: string }[]
  goal: string
  strategy: Strategy
  intro: string
  steps: Step[]
  /** Where the proof came from in the document, if it was read from it. */
  source?: { file: string; inDocument: boolean; theoremEnd?: number }
  logicCache: Record<string, { follows: 'yes' | 'partly' | 'no'; gap: string }>
}

export const KINDS: StepKind[] = ['assume', 'derive', 'case', 'base', 'inductive', 'conclude']
const STORE = '.texdesk/proofs.json'

export function emptyProof(statement = ''): Proof {
  return { statement, hypotheses: [], goal: '', strategy: 'auto', intro: '', steps: [], logicCache: {} }
}

export async function loadProof(host: AppHost): Promise<Proof | null> {
  try {
    const raw = await host.readProjectFile(STORE)
    return raw ? (JSON.parse(raw).proof as Proof) : null
  } catch {
    return null
  }
}

export const saveProof = (host: AppHost, proof: Proof) => host.writeProjectFile(STORE, JSON.stringify({ proof }, null, 1))

let counter = 0
export const newId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}`

/** "Step 3" / "H1" for a step or hypothesis id. */
export function refLabel(proof: Proof, id: string) {
  const s = proof.steps.findIndex(x => x.id === id)
  if (s >= 0) return `Step ${s + 1}`
  const h = proof.hypotheses.findIndex(x => x.id === id)
  return h >= 0 ? `H${h + 1}` : id
}

/** Replace step/hypothesis ids in a justification with their labels. */
export function withLabels(proof: Proof, text: string) {
  const ids = [...proof.steps.map(s => s.id), ...proof.hypotheses.map(h => h.id)].sort((a, b) => b.length - a.length)
  let out = text
  for (const id of ids) out = out.replace(new RegExp(`\\b${id}\\b`, 'g'), refLabel(proof, id))
  return out
}

// ---------- building with AI ----------

const BUILD_SYSTEM =
  'You are a careful mathematician. You write rigorous proofs as a numbered list of small steps, each making one inference. Answer with JSON only.'

const STEP_FORMAT =
  '{"id":"s1","kind":"assume|derive|case|base|inductive|conclude","claim":"the statement of this step, maths in $...$","justification":"why it holds: the rule, definition, theorem or algebra used, referring to earlier steps by id (s1, s2) and hypotheses (h1)","uses":["h1","s1"]}'

type RawProof = { strategy?: string; hypotheses?: { id?: string; text?: string }[]; goal?: string; intro?: string; steps?: RawStep[] }
type RawStep = { id?: string; kind?: string; claim?: string; justification?: string; uses?: unknown }

function toSteps(raw: RawStep[]): Step[] {
  return raw
    .filter(s => s && typeof s.claim === 'string' && s.claim.trim())
    .map(s => ({
      id: String(s.id || newId()),
      kind: (KINDS.includes(s.kind as StepKind) ? s.kind : 'derive') as StepKind,
      claim: s.claim!.trim(),
      justification: String(s.justification ?? '').trim(),
      uses: Array.isArray(s.uses) ? s.uses.map(String) : [],
      status: 'unchecked' as Verdict,
      notes: [],
    }))
}

export async function buildSteps(statement: string, strategy: Strategy, job: Job): Promise<Proof> {
  const r = runAi({
    feature: 'proof',
    system: BUILD_SYSTEM,
    json: true,
    maxTokens: 12000,
    messages: [
      {
        role: 'user',
        content:
          `Theorem: ${statement}\n\nMethod: ${strategy === 'auto' ? 'choose the most natural one' : strategy}\n\n` +
          'Return JSON: {"strategy":"direct|contradiction|contrapositive|induction|cases","hypotheses":[{"id":"h1","text":"what is given, maths in $...$"}],' +
          '"goal":"what must be shown, maths in $...$","intro":"one sentence announcing the method, e.g. We proceed by induction on $n$.",' +
          `"steps":[${STEP_FORMAT}]}\n\n` +
          'Rules:\n- Each step makes ONE inference. Write every algebraic manipulation as an explicit equation or inequality so it can be checked.\n' +
          '- A step may only use hypotheses and EARLIER steps.\n' +
          '- Induction: a base step (kind base), the inductive hypothesis (kind assume), the inductive step (kind inductive), then conclude.\n' +
          '- Contradiction: first assume the negation (kind assume), derive a contradiction, then conclude.\n' +
          '- Cases: one step of kind case per case, each followed by its derivation.\n' +
          '- The last step has kind conclude and states the goal.\n' +
          '- 3 to 15 steps. Standard LaTeX only (\\frac, \\sqrt, \\sum_{i=1}^{n}, \\leq).',
      },
    ],
  })
  job.cancel = r.cancel
  const raw = extractJson<RawProof>((await r.result).text)
  if (!raw?.steps?.length) throw new Error('The model didn’t return any steps. Try again, or pick a method.')
  const hypotheses = (raw.hypotheses ?? []).filter(h => h?.text).map((h, i) => ({ id: String(h.id || `h${i + 1}`), text: String(h.text) }))
  const strat = (['direct', 'contradiction', 'contrapositive', 'induction', 'cases'].includes(String(raw.strategy)) ? raw.strategy : strategy) as Strategy
  return { statement, hypotheses, goal: String(raw.goal ?? ''), strategy: strat, intro: String(raw.intro ?? ''), steps: toSteps(raw.steps), logicCache: {} }
}

/** Split one step into smaller steps; the last keeps the original id so later references stay valid. */
export async function expandStep(proof: Proof, index: number, job: Job) {
  const step = proof.steps[index]
  const r = runAi({
    feature: 'proof',
    system: BUILD_SYSTEM,
    json: true,
    maxTokens: 8000,
    messages: [
      {
        role: 'user',
        content:
          `Theorem: ${proof.statement}\n${context(proof, index)}\n\nStep to expand (${step.id}): ${step.claim}\nBecause: ${step.justification}\n\n` +
          `Split this step into 2 to 5 smaller steps that together establish it, each making one inference. Return {"steps":[${STEP_FORMAT}]} with new ids; the last sub-step must state the original step's claim.`,
      },
    ],
  })
  job.cancel = r.cancel
  const sub = toSteps(extractJson<{ steps?: RawStep[] }>((await r.result).text)?.steps ?? [])
  if (sub.length < 2) throw new Error('The model couldn’t split this step further.')
  const known = new Set([...proof.steps.map(s => s.id), ...proof.hypotheses.map(h => h.id)])
  const fresh = new Map(sub.map(s => [s.id, known.has(s.id) ? s.id : newId()]))
  sub[sub.length - 1].id = step.id
  sub.forEach((s, i) => {
    if (i < sub.length - 1) s.id = fresh.get(s.id)!
    s.uses = s.uses.map(u => fresh.get(u) ?? u)
  })
  // the last sub-step stands where the original was: same id, same kind
  sub[sub.length - 1].kind = step.kind
  proof.steps.splice(index, 1, ...sub)
}

/** Hypotheses and the steps before `index`, for prompts. */
function context(proof: Proof, index: number) {
  const hyp = proof.hypotheses.map((h, i) => `H${i + 1} (${h.id}): ${h.text}`).join('\n')
  const earlier = proof.steps
    .slice(0, index)
    .map((s, i) => `Step ${i + 1} (${s.id}): ${s.claim}${s.justification ? ` [because: ${s.justification}]` : ''}`)
    .join('\n')
  return `${hyp ? `Given:\n${hyp}\n` : ''}${earlier ? `Earlier steps:\n${earlier}` : 'There are no earlier steps.'}`
}

// ---------- checking ----------

export async function checkProof(proof: Proof, job: Job, progress: (msg: string, proof: Proof) => void) {
  const pos = new Map(proof.steps.map((s, i) => [s.id, i]))
  const hyps = new Set(proof.hypotheses.map(h => h.id))
  for (const s of proof.steps) (s.notes = []), (s.status = 'checking'), (s.algebra = undefined)

  // 1. order: a step may only use hypotheses and earlier steps
  const orderBroken = new Set<string>()
  proof.steps.forEach((s, i) => {
    for (const u of s.uses) {
      if (hyps.has(u)) continue
      const j = pos.get(u)
      if (j == null) s.notes.push(`Refers to “${u}”, which isn’t a step or hypothesis.`)
      else if (j >= i) (s.notes.push(`Uses Step ${j + 1}, which ${j === i ? 'is this step itself' : 'comes later'}: a step can only rely on what is already proved.`), orderBroken.add(s.id))
    }
  })

  // 2. algebra, in order, with assumptions and definitions carried forward
  const algebra = checkAlgebra([
    ...proof.hypotheses.map(h => ({ text: h.text, kind: 'assume' as const })),
    ...proof.steps.map(s => ({ text: s.claim, kind: s.kind })),
  ]).slice(proof.hypotheses.length)
  proof.steps.forEach((s, i) => {
    s.algebra = algebra[i]
    if (algebra[i].note && (algebra[i].status === 'fail' || algebra[i].status === 'warn')) s.notes.push(`Algebra: ${algebra[i].note}`)
  })
  progress('Checked order and algebra', proof)

  // 3. logic: does each step follow from what comes before it?
  for (const [i, s] of proof.steps.entries()) {
    if (job.stopped) break
    if (orderBroken.has(s.id) || s.algebra?.status === 'fail') {
      s.status = 'fail'
      progress(`Step ${i + 1} fails`, proof)
      continue
    }
    // keyed by text, not ids: a proof re-read from the document gets new ids but the same verdicts
    const before = proof.steps.slice(0, i).map(p => `${p.claim}|${p.justification}`).join('\n')
    const key = hash(`${proof.statement}|${proof.hypotheses.map(h => h.text).join('|')}|${before}|${s.kind}|${s.claim}|${s.justification}|${s.algebra?.status}`)
    if (!proof.logicCache[key]) {
      progress(`Checking Step ${i + 1} of ${proof.steps.length}…`, proof)
      const last = s.kind === 'conclude' || i === proof.steps.length - 1
      const r = runAi({
        feature: 'proof',
        system:
          'You check proofs one step at a time. A step follows if a competent mathematician would accept it from the hypotheses, the earlier steps and its stated reason. Assumptions that set up a method (e.g. "suppose, for contradiction", "inductive hypothesis", "let n = 2k+1 for some integer k", "write the fraction in lowest terms", "without loss of generality") follow if they are legitimate for that method. Answer with JSON only.',
        json: true,
        maxTokens: 6000,
        messages: [
          {
            role: 'user',
            content:
              `Theorem: ${proof.statement}\n${proof.strategy !== 'auto' ? `Method: ${proof.strategy}\n` : ''}${context(proof, i)}\n\n` +
              `Step ${i + 1} to check: ${s.claim}${s.justification ? `\nIts reason: ${s.justification}` : ''}\n` +
              (s.algebra?.status === 'ok' ? 'Its algebra has already been verified numerically; judge the reasoning.\n' : '') +
              `\nDoes Step ${i + 1} follow?${last ? ' As the final step, does it also complete the proof of the theorem?' : ''} ` +
              'Return {"follows": "yes|partly|no", "gap": "what is missing or wrong, in one sentence (empty if yes)"}.',
          },
        ],
      })
      job.cancel = r.cancel
      const v = extractJson<{ follows?: string; gap?: string }>((await r.result).text)
      if (job.stopped) break
      proof.logicCache[key] = { follows: v?.follows === 'yes' || v?.follows === 'no' ? v.follows : 'partly', gap: String(v?.gap ?? '') }
    }
    const logic = proof.logicCache[key]
    if (logic.follows !== 'yes') s.notes.push(`${logic.follows === 'no' ? 'Doesn’t follow' : 'Only partly follows'}: ${logic.gap || 'the reasoning is incomplete.'}`)
    s.status =
      logic.follows === 'no'
        ? 'fail'
        : logic.follows === 'partly' || s.algebra?.status === 'warn' || s.notes.some(n => n.startsWith('Refers to'))
          ? 'partly'
          : 'ok'
    progress(`Step ${i + 1}: ${s.status === 'ok' ? 'follows' : s.status === 'partly' ? 'partly follows' : 'doesn’t follow'}`, proof)
  }
  for (const s of proof.steps) if (s.status === 'checking') s.status = 'unchecked'
  return proof.steps.findIndex(s => s.status === 'fail')
}

// ---------- skeletons (no AI) ----------

export function skeleton(statement: string, strategy: Strategy): Proof {
  const p = emptyProof(statement)
  p.strategy = strategy === 'auto' ? 'direct' : strategy
  const st = (kind: StepKind, claim: string): Step => ({ id: newId(), kind, claim, justification: '', uses: [], status: 'unchecked', notes: [] })
  const plans: Record<Exclude<Strategy, 'auto'>, [string, Step[]]> = {
    direct: ['We prove the statement directly.', [st('assume', 'Assume the hypotheses: …'), st('derive', '…'), st('derive', '…'), st('conclude', 'Therefore the statement holds.')]],
    contradiction: [
      'We argue by contradiction.',
      [st('assume', 'Suppose, for contradiction, that the statement is false: …'), st('derive', '…'), st('derive', 'This contradicts …'), st('conclude', 'Hence the assumption was false, and the statement holds.')],
    ],
    contrapositive: [
      'We prove the contrapositive.',
      [st('assume', 'Suppose the conclusion fails: …'), st('derive', '…'), st('conclude', 'Then the hypothesis fails, so by contraposition the statement holds.')],
    ],
    induction: [
      'We proceed by induction on $n$.',
      [
        st('base', 'Base case ($n = 1$): …'),
        st('assume', 'Inductive hypothesis: suppose the statement holds for $n = k$.'),
        st('inductive', 'Inductive step: then it holds for $n = k + 1$, because …'),
        st('conclude', 'By induction, the statement holds for all $n \\geq 1$.'),
      ],
    ],
    cases: ['We consider cases.', [st('case', 'Case 1: …'), st('derive', '…'), st('case', 'Case 2: …'), st('derive', '…'), st('conclude', 'In every case the statement holds.')]],
  }
  ;[p.intro, p.steps] = plans[p.strategy as Exclude<Strategy, 'auto'>]
  return p
}

// ---------- reading a proof from the document ----------

const THEOREM_ENV = /^(theorem|thm|lemma|lem|proposition|prop|corollary|cor|claim|fact|result)\*?$/i

type Env = { name: string; from: number; bodyFrom: number; bodyTo: number; to: number }

/** Every \begin{name}…\end{name} pair for the given names (no nesting of the same name assumed). */
function envs(doc: string, names: (n: string) => boolean): Env[] {
  const out: Env[] = []
  const re = /\\begin\{([a-zA-Z*]+)\}(\[[^\]]*\])?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(doc))) {
    if (!names(m[1])) continue
    const endTag = `\\end{${m[1]}}`
    const end = doc.indexOf(endTag, m.index)
    if (end < 0) continue
    out.push({ name: m[1], from: m.index, bodyFrom: m.index + m[0].length, bodyTo: end, to: end + endTag.length })
  }
  return out
}

/** The theorem-like environment at `pos`, if any. */
export function theoremAt(doc: string, pos: number) {
  return envs(doc, n => THEOREM_ENV.test(n)).find(e => e.from <= pos && pos <= e.to) ?? null
}

/** Blank out comments and mask maths, keeping offsets, so sentence splitting can't cut inside them. */
function masked(text: string) {
  let t = text.replace(/(^|[^\\])%[^\n]*/g, (m, pre: string) => pre + ' '.repeat(m.length - pre.length))
  const display: [number, number][] = []
  t = t.replace(/\\begin\{(equation|align|gather|multline|eqnarray|flalign)\*?\}[\s\S]*?\\end\{\1\*?\}|\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$/g, (m, _e, off: number) => (display.push([off, off + m.length]), 'X'.repeat(m.length)))
  t = t.replace(/\$[^$]*\$|\\\([\s\S]*?\\\)/g, m => 'X'.repeat(m.length))
  return { t, display }
}

function kindOf(text: string, last: boolean): StepKind {
  const s = text.trim().toLowerCase()
  if (/^(base case|(for|when) \$?n\s*=\s*[01]\b)/.test(s)) return 'base'
  if (/^case\b/.test(s)) return 'case'
  if (/^(inductive step|for the inductive step)/.test(s)) return 'inductive'
  if (/^(suppose|assume|let\b|given\b|towards a contradiction|for (a )?contradiction|inductive hypothesis|by the inductive hypothesis, suppose)/.test(s)) return 'assume'
  if (last || /^(therefore|hence|thus|this (proves|completes)|we conclude|so the (claim|statement|theorem))/.test(s)) return last ? 'conclude' : 'derive'
  return 'derive'
}

/**
 * The proof around `pos` (or the one right after the theorem at `pos`), split into steps: list items if it
 * is written as a list, otherwise sentences, with each displayed equation its own step.
 */
export function parseProof(doc: string, pos: number, file: string): Proof | null {
  const proofs = envs(doc, n => n === 'proof')
  let pf = proofs.find(e => e.from <= pos && pos <= e.to)
  const thmAtPos = theoremAt(doc, pos)
  if (!pf && thmAtPos) pf = proofs.find(e => e.from >= thmAtPos.to && e.from - thmAtPos.to < 400)
  if (!pf) return null
  const thm = envs(doc, n => THEOREM_ENV.test(n))
    .filter(e => e.to <= pf!.from && pf!.from - e.to < 400)
    .pop()
  const body = doc.slice(pf.bodyFrom, pf.bodyTo)
  const blank = masked(body).t
  const pieces: [number, number][] = []
  if (/\\item\b/.test(body)) {
    const items = [...body.matchAll(/\\item\b(\[[^\]]*\])?/g)]
    const listStart = body.search(/\\begin\{(enumerate|itemize)\}/)
    if (listStart > 0) pieces.push([0, listStart])
    items.forEach((m, k) => {
      const from = m.index! + m[0].length
      const end = k + 1 < items.length ? items[k + 1].index! : body.search(/\\end\{(enumerate|itemize)\}/) >= 0 ? body.search(/\\end\{(enumerate|itemize)\}/) : body.length
      pieces.push([from, end])
    })
    const listEnd = body.search(/\\end\{(enumerate|itemize)\}[^]*$/)
    if (listEnd >= 0) {
      const after = body.indexOf('}', listEnd) + 1
      if (body.slice(after).trim()) pieces.push([after, body.length])
    }
  } else {
    const { t, display } = masked(body)
    let start = 0
    const cut = (end: number) => {
      if (body.slice(start, end).trim()) pieces.push([start, end])
      start = end
    }
    for (let i = 0; i < t.length; i++) {
      const d = display.find(([a]) => a === i)
      if (d) {
        // a lead-in like "Squaring," belongs to the display it introduces
        if (/[.!?]\s*$/.test(t.slice(start, d[0])) || !body.slice(start, d[0]).trim()) cut(d[0])
        // trailing punctuation belongs to the display
        let e = d[1]
        while (/[.,;]/.test(body[e] ?? '')) e++
        cut(e)
        i = e - 1
        continue
      }
      if (/[.!?]/.test(t[i]) && (/\s/.test(t[i + 1] ?? ' ') || i + 1 === t.length)) cut(i + 1)
    }
    cut(body.length)
  }
  const proof = emptyProof(thm ? doc.slice(thm.bodyFrom, thm.bodyTo).replace(/\\label\{[^}]*\}/g, '').trim() : '')
  proof.source = { file, inDocument: true }
  const usable = pieces
    .map(([a, b]) => {
      let from = a
      let to = b
      // trim whitespace and comments (blanked in the masked copy)
      while (from < to && /\s/.test(blank[from])) from++
      while (to > from && /\s/.test(blank[to - 1])) to--
      return [from, to] as [number, number]
    })
    .filter(([a, b]) => b > a && /[A-Za-z0-9]/.test(body.slice(a, b)))
  proof.steps = usable.map(([a, b], k) => {
    const text = body.slice(a, b)
    return { id: newId(), kind: kindOf(text, k === usable.length - 1), claim: text, justification: '', uses: [], status: 'unchecked', notes: [], text }
  })
  return proof
}

// ---------- LaTeX output ----------

const asMath = (claim: string) => (/\$|\\\(|\\\[|\\begin\{/.test(claim) || !mathOf(claim).length ? claim : `$${claim}$`)

export function proofLatex(proof: Proof, withTheorem: boolean) {
  const lines: string[] = []
  if (withTheorem && proof.statement.trim()) lines.push('\\begin{theorem}', proof.statement.trim(), '\\end{theorem}')
  lines.push('\\begin{proof}')
  if (proof.intro.trim()) lines.push(proof.intro.trim())
  if (proof.hypotheses.length) lines.push(`Given: ${proof.hypotheses.map((h, i) => `(H${i + 1})~${h.text}`).join('; ')}.`)
  lines.push('\\begin{enumerate}[label=\\textbf{Step \\arabic*.}, leftmargin=*]')
  for (const s of proof.steps) {
    const why = s.justification.trim() ? ` \\hfill{\\small(${withLabels(proof, s.justification.trim()).replace(/Step (\d+)/g, 'Step~$1')})}` : ''
    lines.push(`  \\item ${asMath(s.claim.trim())}${why}`)
  }
  lines.push('\\end{enumerate}', '\\end{proof}')
  return lines.join('\n')
}
