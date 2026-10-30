// Research-bias matrix: sections × bias types, each cell 0–100% with how it was scored and the evidence.
// Measured rows come from the bibliography and the fact check; AI rows from one model call per section.
import { extractJson, runAi } from './ai-client'
import { bibEntries } from './bib-project'
import type { AppHost } from './host'
import { Claim, Graph, Job, allClaims } from './knowledge'
import { readable } from './factcheck'
import { hash } from './prose'

export type BiasRow = 'source' | 'confirmation' | 'overclaim' | 'counter' | 'framing'
export const ROWS: { id: BiasRow; label: string; how: string }[] = [
  { id: 'source', label: 'Source selection', how: 'Measured: concentration of first authors (35%) and venues (25%) among the works cited in the section (Herfindahl index), plus the share of claims with no citation or support (40%).' },
  { id: 'confirmation', label: 'Confirmation bias', how: 'Mixed: share of claims that a source in your library or the web contradicts while the section never cites it, averaged with the AI estimate of how one-sided the evidence selection is.' },
  { id: 'overclaim', label: 'Overclaiming', how: 'Measured: share of strongly worded claims (shows, proves, always) whose evidence is only partial, missing or contradicting.' },
  { id: 'counter', label: 'Missing counterarguments', how: 'Mixed: AI estimate of missing limitations or alternative explanations, +15 when no limitation or contrast words (however, although, limitation, may not) appear.' },
  { id: 'framing', label: 'Framing', how: 'AI estimate: one-sided or loaded presentation of results (emphasis, selective comparisons, emotive wording).' },
]

export type Cell = { score: number | null; kind: 'measured' | 'ai' | 'mixed'; evidence: string[] }
export type Matrix = { sections: string[]; cells: Record<string, Record<BiasRow, Cell>> }

/** Normalized Herfindahl concentration: 0 = evenly spread, 1 = all the same. */
export function concentration(items: string[]) {
  const n = items.length
  if (n < 2) return n === 1 ? 1 : 0
  const counts = new Map<string, number>()
  items.forEach(i => counts.set(i, (counts.get(i) ?? 0) + 1))
  const hhi = [...counts.values()].reduce((s, c) => s + (c / n) ** 2, 0)
  return Math.max(0, (hhi - 1 / n) / (1 - 1 / n))
}

const pct = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 100)
const LIMIT_WORDS = /\b(however|although|though|whereas|limitation|limitations|in contrast|on the other hand|may not|might not|caveat|nevertheless|alternatively)\b/i

export async function biasMatrix(host: AppHost, g: Graph, job: Job, progress: (msg: string) => void): Promise<Matrix> {
  const claims = allClaims(g)
  const paras = Object.values(g.paras)
  const sections = [...new Set(paras.map(p => p.section || 'Untitled'))]
  const bib = await bibEntries(host)
  const supported = new Set(g.edges.filter(e => e.rel === 'supports').map(e => e.to))
  const cells: Matrix['cells'] = {}

  for (const [si, section] of sections.entries()) {
    const sc = claims.filter(c => (c.section || 'Untitled') === section)
    const text = paras.filter(p => (p.section || 'Untitled') === section).map(p => p.text).join('\n\n')
    const cited = [...new Set([...text.matchAll(/\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\]){0,2}\{([^}]*)\}/g)].flatMap(m => m[1].split(',').map(k => k.trim())))]
    const entries = cited.map(k => bib.get(k)).filter(Boolean)

    // source selection (measured)
    const firstAuthors = entries.map(e => (e!.fields.author ?? '').split(/\s+and\s+/i)[0].replace(/[{}]/g, '').split(',')[0].trim().toLowerCase()).filter(Boolean)
    const venues = entries.map(e => (e!.fields.journal ?? e!.fields.journaltitle ?? e!.fields.booktitle ?? e!.fields.publisher ?? '').replace(/[{}]/g, '').toLowerCase()).filter(Boolean)
    const factual = sc.filter(c => c.kind === 'claim' || c.kind === 'result' || c.kind === 'conclusion')
    const uncited = factual.filter(c => !c.citekeys.length && !supported.has(c.id) && g.evidence[c.id]?.verdict !== 'supported')
    const uncitedShare = factual.length ? uncited.length / factual.length : 0
    const source = entries.length ? 0.35 * concentration(firstAuthors) + 0.25 * concentration(venues) + 0.4 * uncitedShare : uncitedShare
    const sourceEv = [
      `${entries.length} cited work${entries.length === 1 ? '' : 's'}${firstAuthors.length ? `; first authors: ${[...new Set(firstAuthors)].join(', ')}` : ''}`,
      `${uncited.length} of ${factual.length} factual claims have no citation or support`,
      ...uncited.slice(0, 4).map(c => `uncited: “${readable(c.text).slice(0, 100)}”`),
    ]

    // overclaiming (measured)
    const strong = sc.filter(c => c.strength === 'strong' && g.evidence[c.id])
    const weak = strong.filter(c => ['partial', 'not_found', 'contradicted', 'needs_citation'].includes(g.evidence[c.id].verdict))
    const overclaim = strong.length ? weak.length / strong.length : 0

    // contradicting evidence the section ignores (measured half of confirmation)
    const ignored = sc.filter(c => {
      const ev = g.evidence[c.id]
      return ev?.verdict === 'contradicted' && (ev.source !== 'cited') && !(ev.citekey && cited.includes(ev.citekey))
    })
    const ignoredShare = factual.length ? ignored.length / factual.length : 0

    // AI estimates, one call per section, cached by the section's text
    const key = hash(text)
    let ai = g.sections[section]
    if (!ai || ai.key !== key) {
      if (job.stopped) break
      progress(`Assessing bias: section ${si + 1} of ${sections.length}`)
      const r = runAi({
        feature: 'analysis',
        system: 'You review academic writing for research bias. Be fair: well-balanced text should score low. Answer with JSON only.',
        json: true,
        maxTokens: 600,
        messages: [
          {
            role: 'user',
            content:
              `Section "${section}":\n<<<\n${text.slice(0, 12000)}\n>>>\n\n` +
              'Score 0-100 (0 = none, 100 = severe): "confirmation" (only evidence for one view is selected), ' +
              '"missing_counterarguments" (limitations and alternative explanations are absent), "framing" (results presented one-sidedly or with loaded wording). ' +
              'Return {"confirmation": n, "missing_counterarguments": n, "framing": n, "notes": "two sentences citing specific wording"}.',
          },
        ],
      })
      job.cancel = r.cancel
      const v = extractJson<{ confirmation?: number; missing_counterarguments?: number; framing?: number; notes?: string }>((await r.result).text)
      const n = (x: unknown) => (typeof x === 'number' && isFinite(x) ? Math.max(0, Math.min(100, x)) : 0)
      ai = { confirmation: n(v?.confirmation), counterarguments: n(v?.missing_counterarguments), framing: n(v?.framing), notes: v?.notes ?? '', key }
      g.sections[section] = ai
    }

    const counterBoost = LIMIT_WORDS.test(text) ? 0 : 15
    cells[section] = {
      source: { score: pct(source), kind: 'measured', evidence: sourceEv },
      confirmation: {
        score: Math.round((pct(ignoredShare) + ai.confirmation) / 2),
        kind: 'mixed',
        evidence: [
          `${ignored.length} claim${ignored.length === 1 ? '' : 's'} contradicted by a source the section doesn't cite`,
          ...ignored.slice(0, 3).map(c => `“${readable(c.text).slice(0, 90)}” vs ${g.evidence[c.id].citekey ?? g.evidence[c.id].title}`),
          `AI: ${ai.confirmation}/100. ${ai.notes}`,
        ],
      },
      overclaim: {
        score: pct(overclaim),
        kind: 'measured',
        evidence: [`${weak.length} of ${strong.length} strongly worded checked claims lack full support`, ...weak.slice(0, 4).map(c => `“${readable(c.text).slice(0, 90)}” (${g.evidence[c.id].verdict.replace('_', ' ')})`)],
      },
      counter: {
        score: Math.min(100, ai.counterarguments + counterBoost),
        kind: 'mixed',
        evidence: [`AI: ${ai.counterarguments}/100`, counterBoost ? 'No limitation or contrast wording found (+15)' : 'Limitation or contrast wording present', ai.notes],
      },
      framing: { score: ai.framing, kind: 'ai', evidence: [`AI: ${ai.framing}/100. ${ai.notes}`] },
    }
  }
  return { sections: sections.filter(s => cells[s]), cells }
}

export const claimsBySection = (claims: Claim[], section: string) => claims.filter(c => (c.section || 'Untitled') === section)
