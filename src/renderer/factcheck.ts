// Fact check, grounded in sources: a cited claim is checked against passages from the papers it cites
// (or their abstracts); an uncited claim is checked against the Zotero library, then free web sources.
// The model only judges against retrieved text; web results are offered as possible sources, never "proof".
import { extractJson, runAi } from './ai-client'
import { bibEntries } from './bib-project'
import type { AppHost } from './host'
import { Claim, Evidence, Graph, Job, allClaims } from './knowledge'
import { Passage, zotero, zoteroStatus } from './zotero-client'

type WebHit = { kind: 'paper' | 'wikipedia'; title: string; year: number | null; text: string; url?: string; doi?: string }
type WebBridge = { abstract(doi: string): Promise<{ title?: string; abstract: string; source: string } | null>; evidence(claim: string): Promise<WebHit[]> }
const web: WebBridge = (window as unknown as { texdesk: { web: WebBridge } }).texdesk.web

const SYSTEM =
  'You check claims in academic writing against source passages. Judge ONLY from the passages given, never from your own knowledge. Answer with JSON only.'

/** A claim's LaTeX reduced to readable text for searching. */
export const readable = (latex: string) =>
  latex
    .replace(/~?\\[a-zA-Z]*cite[a-zA-Z]*\*?(\[[^\]]*\]){0,2}\{[^}]*\}/g, '')
    .replace(/\\(textbf|textit|emph|underline|texttt)\{([^}]*)\}/g, '$2')
    .replace(/\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?/g, '')
    .replace(/[{}$~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

async function judge(claim: Claim, passages: { label: string; text: string }[], question: string, job: Job) {
  const r = runAi({
    feature: 'analysis',
    system: SYSTEM,
    json: true,
    maxTokens: 700,
    messages: [
      {
        role: 'user',
        content:
          `Claim: ${readable(claim.text)}\n\nPassages:\n${passages.map((p, i) => `[${i + 1}] (${p.label}) ${p.text}`).join('\n\n')}\n\n${question}\n` +
          'Return {"verdict": "...", "passage": number or null, "quote": "exact sentence from that passage, or empty", "explanation": "one or two sentences"}.',
      },
    ],
  })
  job.cancel = r.cancel
  return extractJson<{ verdict?: string; passage?: number | null; quote?: string; explanation?: string }>((await r.result).text)
}

async function checkCited(host: AppHost, claim: Claim, job: Job, libraryOn: boolean): Promise<Evidence> {
  let passages: { label: string; text: string; citekey: string; title?: string }[] = []
  let abstractOnly = false
  if (libraryOn) {
    try {
      const found = await zotero.retrieve(readable(claim.text), 5, claim.citekeys)
      passages = found.passages.map((p: Passage) => ({ label: `${p.citekey}, ${p.title}`, text: p.text, citekey: p.citekey, title: p.title }))
    } catch {}
  }
  if (!passages.length) {
    // the cited paper isn't readable in Zotero: use its abstract, found by DOI
    const bib = await bibEntries(host)
    for (const key of claim.citekeys) {
      const doi = bib.get(key)?.fields.doi
      if (!doi) continue
      const a = await web.abstract(doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')).catch(() => null)
      if (a?.abstract) passages.push({ label: `${key}, abstract`, text: a.abstract, citekey: key, title: a.title })
    }
    abstractOnly = passages.length > 0
  }
  if (!passages.length)
    return { verdict: 'not_found', source: 'cited', citekey: claim.citekeys[0], explanation: "Couldn't read the cited source: it isn't in Zotero with a PDF, and no abstract was found online.", abstractOnly: true }
  const v = await judge(
    claim,
    passages,
    'Does the cited source say what the claim says? verdict: "supported" (clearly says it), "partial" (says something weaker or narrower), "contradicted" (says the opposite), or "not_found" (the passages do not address it).',
    job
  )
  const verdict = (['supported', 'partial', 'contradicted', 'not_found'].includes(String(v?.verdict)) ? v!.verdict : 'not_found') as Evidence['verdict']
  const p = passages[(v?.passage ?? 1) - 1] ?? passages[0]
  return { verdict, source: 'cited', citekey: p.citekey, title: p.title, quote: v?.quote || '', explanation: v?.explanation || '', abstractOnly }
}

async function checkUncited(claim: Claim, job: Job, libraryOn: boolean, allowWeb: boolean): Promise<Evidence> {
  const question =
    'Does any passage support or contradict the claim? verdict: "supported", "contradicted", or "none". Give the passage number.'
  if (libraryOn) {
    try {
      const found = await zotero.retrieve(readable(claim.text), 4)
      if (found.passages.length) {
        const v = await judge(claim, found.passages.map(p => ({ label: `${p.citekey}, ${p.title}`, text: p.text })), question, job)
        const p = found.passages[(v?.passage ?? 1) - 1]
        if (p && v?.verdict === 'supported')
          return { verdict: 'possible_source', source: 'library', citekey: p.citekey, title: p.title, quote: v.quote || '', explanation: v.explanation || `Your library supports this: consider citing ${p.citekey}.` }
        if (p && v?.verdict === 'contradicted')
          return { verdict: 'contradicted', source: 'library', citekey: p.citekey, title: p.title, quote: v.quote || '', explanation: v.explanation || `A paper in your library disagrees (${p.citekey}).` }
      }
    } catch {}
  }
  if (allowWeb) {
    const hits = await web.evidence(readable(claim.text)).catch(() => [] as WebHit[])
    if (hits.length) {
      const v = await judge(claim, hits.map(h => ({ label: `${h.kind === 'wikipedia' ? 'Wikipedia' : 'paper'}: ${h.title}`, text: h.text })), question, job)
      const h = hits[(v?.passage ?? 1) - 1]
      if (h && v?.verdict === 'supported')
        return { verdict: 'possible_source', source: 'web', title: h.title, url: h.url, quote: v.quote || '', explanation: v.explanation || 'A web source appears to support this; verify it and cite a proper source.' }
      // a loosely matched web page isn't strong enough to call the claim false: flag it softly
      if (h && v?.verdict === 'contradicted')
        return { verdict: 'needs_citation', source: 'web', title: h.title, url: h.url, quote: v.quote || '', explanation: `A web source may disagree (${h.title}); check it and cite a proper source. ${v.explanation ?? ''}`.trim() }
    }
  }
  return { verdict: 'needs_citation', source: 'none', explanation: 'No source in your library (or the free web sources) addresses this claim. Consider citing one.' }
}

/** Which claims need evidence: anything cited, plus uncited claims/results/conclusions that aren't hedged. */
export const needsCheck = (c: Claim) =>
  c.citekeys.length > 0 || (c.kind !== 'definition' && c.kind !== 'assumption' && c.strength !== 'hedged')

export async function factCheck(host: AppHost, g: Graph, job: Job, progress: (msg: string) => void, opts: { web: boolean; maxWeb?: number }) {
  const libraryOn = (await zoteroStatus()).localApi
  const todo = allClaims(g).filter(c => needsCheck(c) && !g.evidence[c.id])
  let webUsed = 0
  for (const [i, c] of todo.entries()) {
    if (job.stopped) return
    progress(`Fact-checking claim ${i + 1} of ${todo.length}`)
    const allowWeb = opts.web && webUsed < (opts.maxWeb ?? 15)
    const ev = c.citekeys.length ? await checkCited(host, c, job, libraryOn) : await checkUncited(c, job, libraryOn, allowWeb)
    if (ev.source === 'web' || (!c.citekeys.length && allowWeb)) webUsed++
    g.evidence[c.id] = ev
  }
}
