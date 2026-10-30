// The project knowledge graph: claims extracted from every paragraph, linked by supports/contradicts
// edges, plus fact-check evidence and analysis results. Stored in .texdesk/knowledge.json and rebuilt
// incrementally: a paragraph is only re-read by the model when its text changes.
import { EditorState } from '@codemirror/state'
import { LanguageSupport } from '@codemirror/language'
import { LaTeXLanguage } from '../overleaf/latex-language'
import { extractJson, runAi } from './ai-client'
import type { AppHost } from './host'
import { Paragraph, hash, paragraphs } from './prose'

export type ClaimKind = 'claim' | 'result' | 'definition' | 'assumption' | 'conclusion'
export type Claim = {
  id: string
  para: string
  file: string
  section: string
  text: string
  kind: ClaimKind
  citekeys: string[]
  numbers: { quantity: string; value: number; unit?: string }[]
  strength: 'strong' | 'moderate' | 'hedged'
  vec?: number[]
}
export type Edge = { from: string; to: string; rel: 'supports' | 'contradicts'; reason: string }
export type Verdict = 'supported' | 'partial' | 'not_found' | 'contradicted' | 'needs_citation' | 'possible_source'
export type Evidence = {
  verdict: Verdict
  source: 'cited' | 'library' | 'web' | 'none'
  citekey?: string
  title?: string
  url?: string
  quote?: string
  explanation: string
  abstractOnly?: boolean
}
export type FlowIssue = { find: string; type: 'unclear' | 'non_sequitur' | 'weak_transition' | 'repetition' | 'too_long'; message: string; rewrite?: string }
export type ParaInfo = { file: string; section: string; text: string; claims: Claim[]; flow?: { score: number; issues: FlowIssue[] } }

export type Graph = {
  version: 1
  paras: Record<string, ParaInfo>
  edges: Edge[]
  edgesDone: Record<string, true>
  evidence: Record<string, Evidence>
  conclusions: Record<string, { follows: 'yes' | 'partly' | 'no'; gap: string }>
  sections: Record<string, { confirmation: number; counterarguments: number; framing: number; notes: string; key: string }>
}

const STORE = '.texdesk/knowledge.json'
const empty = (): Graph => ({ version: 1, paras: {}, edges: [], edgesDone: {}, evidence: {}, conclusions: {}, sections: {} })
const KINDS = new Set(['claim', 'result', 'definition', 'assumption', 'conclusion'])

export type Job = { stopped: boolean; cancel?: () => void }

export async function loadGraph(host: AppHost): Promise<Graph> {
  try {
    const raw = await host.readProjectFile(STORE)
    const g = raw ? (JSON.parse(raw) as Graph) : empty()
    return g.version === 1 ? { ...empty(), ...g } : empty()
  } catch {
    return empty()
  }
}

export async function saveGraph(host: AppHost, g: Graph) {
  await host.writeProjectFile(STORE, JSON.stringify(g))
}

export const allClaims = (g: Graph) => Object.values(g.paras).flatMap(p => p.claims)

/** Every prose paragraph in the project's .tex files, in a stable order. */
export async function projectParagraphs(host: AppHost): Promise<(Paragraph & { file: string; key: string })[]> {
  const out: (Paragraph & { file: string; key: string })[] = []
  const main = host.mainFile()
  const files = host.files().filter(f => f.path.endsWith('.tex')).sort((a, b) => (a.path === main ? -1 : b.path === main ? 1 : a.path.localeCompare(b.path)))
  for (const f of files) {
    const text = await host.fileText(f.path)
    const state = EditorState.create({ doc: text, extensions: [new LanguageSupport(LaTeXLanguage)] })
    for (const p of paragraphs(state)) out.push({ ...p, file: f.path, key: hash(`${f.path}\n${p.text}`) })
  }
  return out
}

/** Drop analysis for paragraphs that no longer exist (and edges/evidence hanging off their claims). */
export function prune(g: Graph, current: Set<string>) {
  for (const k of Object.keys(g.paras)) if (!current.has(k)) delete g.paras[k]
  const ids = new Set(allClaims(g).map(c => c.id))
  g.edges = g.edges.filter(e => ids.has(e.from) && ids.has(e.to))
  for (const k of Object.keys(g.edgesDone)) if (!ids.has(k)) delete g.edgesDone[k]
  for (const k of Object.keys(g.evidence)) if (!ids.has(k)) delete g.evidence[k]
}

const SYSTEM = 'You analyse academic LaTeX writing. Answer with JSON only, exactly in the requested shape.'

/** Where a model-quoted span actually sits in the paragraph (exact, else whitespace-insensitive). */
export function locate(paragraph: string, quote: string): string | null {
  if (!quote) return null
  if (paragraph.includes(quote)) return quote
  const words = quote.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!words.length) return null
  const m = paragraph.match(new RegExp(words.join('\\s+')))
  return m ? m[0] : null
}

/** Ask the model for the claims in one paragraph. */
async function extractClaims(p: { text: string; section: string; file: string; key: string }, job: Job): Promise<Claim[]> {
  const r = runAi({
    feature: 'analysis',
    system: SYSTEM,
    json: true,
    maxTokens: 1500,
    messages: [
      {
        role: 'user',
        content:
          `Paragraph from section "${p.section || 'untitled'}" (LaTeX source):\n<<<\n${p.text}\n>>>\n\n` +
          'List the factual claims it makes. Return {"claims": [{"text": "...", "kind": "claim|result|definition|assumption|conclusion", ' +
          '"numbers": [{"quantity": "short name, e.g. participants", "value": 40, "unit": ""}], "strength": "strong|moderate|hedged"}]}.\n' +
          'Rules: "text" must be copied EXACTLY from the source (a sentence or clause, including any \\cite). ' +
          '"strength": strong = certain wording (shows, proves, always), hedged = may/suggests/likely. ' +
          'Skip transitions and signposting. At most 6 claims. Return {"claims": []} if there are none.',
      },
    ],
  })
  job.cancel = r.cancel
  const res = await r.result
  const data = extractJson<{ claims?: Partial<Claim>[] }>(res.text)
  const claims: Claim[] = []
  for (const [i, c] of (data?.claims ?? []).entries()) {
    const text = locate(p.text, String(c.text ?? ''))
    if (!text) continue
    // citation keys come from the actual \cite commands, not the model
    const citekeys = [...text.matchAll(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g)].flatMap(m => m[1].split(',').map(k => k.trim()).filter(Boolean))
    claims.push({
      id: `${p.key}:${i}`,
      para: p.key,
      file: p.file,
      section: p.section,
      text,
      kind: (KINDS.has(String(c.kind)) ? c.kind : 'claim') as ClaimKind,
      citekeys,
      numbers: (Array.isArray(c.numbers) ? c.numbers : []).filter(n => n && typeof n.value === 'number' && n.quantity).map(n => ({ quantity: String(n.quantity).toLowerCase().trim(), value: n.value, unit: n.unit ?? '' })),
      strength: c.strength === 'strong' || c.strength === 'hedged' ? c.strength : 'moderate',
    })
  }
  return claims
}

type EmbedBridge = (texts: string[]) => Promise<number[][]>
const embed: EmbedBridge = (window as unknown as { texdesk: { embed: EmbedBridge } }).texdesk.embed

export const cosine = (a: number[], b: number[]) => {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) (dot += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i])
  return dot / (Math.sqrt(na * nb) || 1)
}

/**
 * Bring the graph up to date: extract claims for new/changed paragraphs, embed them, then link each
 * new claim to its most similar claims.
 */
export async function updateClaims(host: AppHost, g: Graph, job: Job, progress: (msg: string) => void) {
  const ps = await projectParagraphs(host)
  prune(g, new Set(ps.map(p => p.key)))
  const fresh = ps.filter(p => !g.paras[p.key])
  for (const [i, p] of fresh.entries()) {
    if (job.stopped) return
    progress(`Reading claims: paragraph ${i + 1} of ${fresh.length}`)
    const claims = await extractClaims(p, job)
    g.paras[p.key] = { file: p.file, section: p.section, text: p.text, claims }
  }
  // embeddings for claims that don't have one yet
  const need = allClaims(g).filter(c => !c.vec)
  for (let i = 0; i < need.length && !job.stopped; i += 32) {
    progress(`Embedding claims ${i + 1}–${Math.min(i + 32, need.length)} of ${need.length}`)
    const batch = need.slice(i, i + 32)
    try {
      const vecs = await embed(batch.map(c => `clustering: ${c.text}`))
      batch.forEach((c, k) => (c.vec = vecs[k]))
    } catch {
      break // no embedding model: linking falls back to word overlap below
    }
  }
  await linkClaims(g, job, progress)
}

/** Word-overlap similarity, the fallback when there are no embeddings. */
const overlap = (a: string, b: string) => {
  const wa = new Set(a.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  const wb = new Set(b.toLowerCase().match(/[a-z]{4,}/g) ?? [])
  let n = 0
  wa.forEach(w => wb.has(w) && n++)
  return n / (Math.sqrt(wa.size * wb.size) || 1)
}

/** Strict yes/no check that two claims really are incompatible statements about the same thing. */
async function confirmContradiction(a: Claim, b: Claim, job: Job) {
  const r = runAi({
    feature: 'analysis',
    system: SYSTEM,
    json: true,
    maxTokens: 200,
    messages: [
      {
        role: 'user',
        content:
          `Statement 1: ${a.text}\nStatement 2: ${b.text}\n\n` +
          'Do these two statements make incompatible claims about the SAME subject, so that both cannot be true at once? ' +
          'Statements about different topics, or one being more cautious or more general than the other, are NOT contradictions. ' +
          'Return {"contradiction": true|false}.',
      },
    ],
  })
  job.cancel = r.cancel
  return extractJson<{ contradiction?: boolean }>((await r.result).text)?.contradiction === true
}

async function linkClaims(g: Graph, job: Job, progress: (msg: string) => void) {
  const claims = allClaims(g)
  const todo = claims.filter(c => !g.edgesDone[c.id])
  for (const [n, a] of todo.entries()) {
    if (job.stopped) return
    const candidates = claims
      .filter(b => b.id !== a.id && b.para !== a.para)
      .map(b => ({ b, s: a.vec && b.vec ? cosine(a.vec, b.vec) : overlap(a.text, b.text) }))
      .filter(x => x.s > (a.vec ? 0.6 : 0.2))
      .sort((x, y) => y.s - x.s)
      .slice(0, 5)
      .map(x => x.b)
    if (candidates.length) {
      progress(`Linking claims: ${n + 1} of ${todo.length}`)
      const r = runAi({
        feature: 'analysis',
        system: SYSTEM,
        json: true,
        maxTokens: 800,
        messages: [
          {
            role: 'user',
            content:
              `Claim A: ${a.text}\n\nCandidates:\n${candidates.map((b, i) => `${i + 1}. ${b.text}`).join('\n')}\n\n` +
              'For each candidate, how does it relate to claim A? Use "supports_A" (it is evidence or a reason for A), ' +
              '"supported_by_A" (A is evidence or a reason for it), "contradicts" (they make incompatible statements about the SAME thing, ' +
              'so both cannot be true), or "unrelated". Different topics, or one claim being more cautious than another, are not contradictions. When unsure, use "unrelated". ' +
              'Return {"relations": [{"i": 1, "rel": "...", "reason": "short"}]}.',
          },
        ],
      })
      job.cancel = r.cancel
      const data = extractJson<{ relations?: { i: number; rel: string; reason?: string }[] }>((await r.result).text)
      for (const rel of data?.relations ?? []) {
        const b = candidates[rel.i - 1]
        if (!b) continue
        const reason = String(rel.reason ?? '')
        // contradictions get a focused second opinion; first-pass labelling over-reports them
        if (rel.rel === 'contradicts' && !(await confirmContradiction(a, b, job))) continue
        const edge: Edge | null =
          rel.rel === 'supports_A' ? { from: b.id, to: a.id, rel: 'supports', reason } :
          rel.rel === 'supported_by_A' ? { from: a.id, to: b.id, rel: 'supports', reason } :
          rel.rel === 'contradicts' ? { from: a.id, to: b.id, rel: 'contradicts', reason } : null
        if (edge && !g.edges.some(e => e.from === edge.from && e.to === edge.to && e.rel === edge.rel)) g.edges.push(edge)
      }
    }
    g.edgesDone[a.id] = true
  }
}
