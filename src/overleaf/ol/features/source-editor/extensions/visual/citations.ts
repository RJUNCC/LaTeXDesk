// LaTeXDesk: what the visual editor shows for \cite… and the reference list. The app knows the project's
// sources and sets the provider; the decorations read it each time they're rebuilt.
import { StateEffect } from '@codemirror/state'

export type CitationProvider = {
  /** In-text names and year for a key, or null when the key isn't one of the project's sources. */
  label(key: string): { who: string; year: string; title: string } | null
  /** Readable name of a BibTeX style, e.g. apacite → APA. */
  styleName(bst: string): string
  sourceCount(): number
  /** Open the Sources dialog (the reference list widget's button). */
  openSources(): void
}

let provider: CitationProvider = {
  label: () => null,
  styleName: bst => bst,
  sourceCount: () => 0,
  openSources: () => {},
}

export const setCitationProvider = (p: CitationProvider) => {
  provider = p
}
export const citationProvider = () => provider

/** Dispatch this to rebuild the visual decorations after the project's sources change. */
export const refreshCitations = StateEffect.define<null>()

/** The chip text for \command{keys}: "(Smith & Lee, 2020; Doe, 2019)", "Smith & Lee (2020)", … */
export function citationText(command: string, keys: string[]) {
  const labels = keys.map(k => ({ key: k, l: provider.label(k) }))
  const missing = labels.filter(x => !x.l).map(x => x.key)
  const one = ({ key, l }: (typeof labels)[number], textual: boolean) =>
    !l ? key : command.startsWith('citeauthor') || command === 'Citeauthor' ? l.who : command.startsWith('citeyear') ? l.year : textual ? `${l.who} (${l.year})` : `${l.who}, ${l.year}`
  const textual = /^(citet|Citet|citeauthor|Citeauthor|citeyear|textcite|Textcite)\*?$/.test(command)
  const text = textual ? labels.map(x => one(x, true)).join('; ') : `(${labels.map(x => one(x, false)).join('; ')})`
  const title = labels.map(({ key, l }) => (l ? `${l.who} (${l.year}). ${l.title}` : `${key}: not in your sources yet. Add it with 📚 Sources.`)).join('\n')
  return { text, title, missing: missing.length > 0 }
}
