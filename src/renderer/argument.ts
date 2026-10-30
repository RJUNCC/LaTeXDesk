// Argument legitimacy from the knowledge graph: contradictions, circular support, number mismatches,
// unsupported conclusions, overclaiming, and (AI) whether each conclusion follows from its premises.
import { extractJson, runAi } from './ai-client'
import { Claim, Graph, Job, allClaims } from './knowledge'
import { readable } from './factcheck'
import { hash } from './prose'

export type ArgIssue = {
  type: 'contradiction' | 'circular' | 'numbers' | 'unsupported' | 'overclaim' | 'does_not_follow'
  severity: 'error' | 'warning'
  claims: string[]
  message: string
}

/** Strongly connected components of the supports graph with more than one claim (or a self-loop): circular support. */
export function cycles(ids: string[], edges: { from: string; to: string }[]) {
  const adj = new Map(ids.map(id => [id, [] as string[]]))
  for (const e of edges) adj.get(e.from)?.push(e.to)
  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const on = new Set<string>()
  const out: string[][] = []
  const visit = (v: string) => {
    idx.set(v, index)
    low.set(v, index++)
    stack.push(v)
    on.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) (visit(w), low.set(v, Math.min(low.get(v)!, low.get(w)!)))
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        on.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1 || (adj.get(v) ?? []).includes(v)) out.push(comp)
    }
  }
  ids.forEach(v => !idx.has(v) && visit(v))
  return out
}

/** The same quantity stated with different values in different places. */
export function numberConflicts(claims: Claim[]) {
  const norm = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(the|a|an|of|number|total)\b/g, '').replace(/s\b/g, '').replace(/\s+/g, ' ').trim()
  const groups = new Map<string, { value: number; unit: string; claim: Claim }[]>()
  for (const c of claims) for (const n of c.numbers) {
    const key = `${norm(n.quantity)}|${(n.unit ?? '').toLowerCase()}`
    if (!norm(n.quantity)) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ value: n.value, unit: n.unit ?? '', claim: c })
  }
  const out: { quantity: string; entries: { value: number; unit: string; claim: Claim }[] }[] = []
  for (const [key, entries] of groups) if (new Set(entries.map(e => e.value)).size > 1) out.push({ quantity: key.split('|')[0], entries })
  return out
}

export async function analyseArgument(g: Graph, job: Job, progress: (msg: string) => void): Promise<ArgIssue[]> {
  const claims = allClaims(g)
  const byId = new Map(claims.map(c => [c.id, c]))
  const issues: ArgIssue[] = []
  const short = (c?: Claim) => (c ? `“${readable(c.text).slice(0, 90)}${readable(c.text).length > 90 ? '…' : ''}”` : '?')

  // number mismatches are found exactly below; don't also report the same pair as an AI "contradiction"
  const numberPairs = new Set(numberConflicts(claims).flatMap(c => c.entries.map(e => e.claim.id)))
  for (const e of g.edges.filter(e => e.rel === 'contradicts')) {
    if (numberPairs.has(e.from) && numberPairs.has(e.to)) continue
    issues.push({ type: 'contradiction', severity: 'error', claims: [e.from, e.to], message: `These claims contradict each other: ${short(byId.get(e.from))} vs ${short(byId.get(e.to))}. ${e.reason}` })
  }

  for (const comp of cycles(claims.map(c => c.id), g.edges.filter(e => e.rel === 'supports')))
    issues.push({ type: 'circular', severity: 'error', claims: comp, message: `Circular support: these ${comp.length} claims only support each other, with no independent evidence.` })

  for (const conflict of numberConflicts(claims))
    issues.push({
      type: 'numbers',
      severity: 'error',
      claims: conflict.entries.map(e => e.claim.id),
      message: `“${conflict.quantity}” is given as ${[...new Set(conflict.entries.map(e => `${e.value}${e.unit ? ' ' + e.unit : ''}`))].join(' and ')} in different places.`,
    })

  const supportedBy = new Map<string, string[]>()
  for (const e of g.edges.filter(e => e.rel === 'supports')) supportedBy.set(e.to, [...(supportedBy.get(e.to) ?? []), e.from])

  for (const c of claims) {
    const ev = g.evidence[c.id]
    const hasSupport = (supportedBy.get(c.id)?.length ?? 0) > 0 || c.citekeys.length > 0 || ev?.verdict === 'supported'
    if ((c.kind === 'conclusion' || c.kind === 'result') && !hasSupport)
      issues.push({ type: 'unsupported', severity: 'warning', claims: [c.id], message: `${c.kind === 'conclusion' ? 'Conclusion' : 'Result'} with nothing supporting it in the text and no citation: ${short(c)}` })
    if (c.strength === 'strong' && ev && ['partial', 'not_found', 'contradicted', 'needs_citation'].includes(ev.verdict))
      issues.push({ type: 'overclaim', severity: 'warning', claims: [c.id], message: `Strong wording, weaker evidence (${ev.verdict.replace('_', ' ')}): ${short(c)}. Consider hedging (“suggests”, “indicates”).` })
  }

  // does each conclusion actually follow from what supports it? (cached by the exact premises)
  const conclusions = claims.filter(c => c.kind === 'conclusion' && (supportedBy.get(c.id)?.length ?? 0) > 0)
  for (const [i, c] of conclusions.entries()) {
    if (job.stopped) break
    const premises = supportedBy.get(c.id)!.map(id => byId.get(id)!).filter(Boolean)
    const key = hash(c.text + premises.map(p => p.text).join('|'))
    if (!g.conclusions[key]) {
      progress(`Checking reasoning: conclusion ${i + 1} of ${conclusions.length}`)
      const r = runAi({
        feature: 'analysis',
        system: 'You assess whether conclusions in academic writing follow from their premises. Answer with JSON only.',
        json: true,
        maxTokens: 500,
        messages: [
          {
            role: 'user',
            content:
              `Premises:\n${premises.map((p, k) => `${k + 1}. ${readable(p.text)}`).join('\n')}\n\nConclusion: ${readable(c.text)}\n\n` +
              'Does the conclusion follow from these premises? Return {"follows": "yes|partly|no", "gap": "what is missing or assumed, in one sentence (empty if yes)"}.',
          },
        ],
      })
      job.cancel = r.cancel
      const v = extractJson<{ follows?: string; gap?: string }>((await r.result).text)
      g.conclusions[key] = { follows: v?.follows === 'yes' || v?.follows === 'no' ? v.follows : 'partly', gap: v?.gap ?? '' }
    }
    const res = g.conclusions[key]
    if (res.follows !== 'yes')
      issues.push({ type: 'does_not_follow', severity: res.follows === 'no' ? 'error' : 'warning', claims: [c.id, ...premises.map(p => p.id)], message: `Conclusion ${res.follows === 'no' ? 'does not follow' : 'only partly follows'}: ${short(c)}${res.gap ? `. Gap: ${res.gap}` : ''}` })
  }
  return issues
}
