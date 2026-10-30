// LaTeX autocomplete built from Overleaf's bundled completion data.
import {
  Completion,
  CompletionContext,
  CompletionResult,
  snippetCompletion,
} from '@codemirror/autocomplete'
import topHundredSnippets from '../overleaf/data/top-hundred-snippets'
import extraSnippets from '../overleaf/data/snippets'
import { environments } from '../overleaf/data/environments'
import { packageNames } from '../overleaf/data/package-names'
import { classNames } from '../overleaf/data/class-names'

// Same conversion Overleaf uses: "$1" placeholders become CodeMirror "#{1}" fields
const prepareSnippetTemplate = (template: string) =>
  template.replace(/\$(\d+)/g, '#{$1}') + '${}'

const commandCompletions: Completion[] = [
  ...topHundredSnippets.map(item =>
    snippetCompletion(prepareSnippetTemplate(item.snippet), {
      label: item.caption,
      type: item.meta === 'env' ? 'keyword' : 'function',
      boost: Math.min(99, Math.round(item.score * 10)),
    })
  ),
  ...extraSnippets.map(item =>
    snippetCompletion(item.snippet + '${}', { label: item.label, type: 'function' })
  ),
  ...[...environments].map(([name, template]) =>
    snippetCompletion(prepareSnippetTemplate(template), {
      label: `\\begin{${name}} …`,
      type: 'keyword',
      detail: 'env',
    })
  ),
]

const environmentNames = [...environments.keys()]

/** Labels and bib keys gathered from the whole project by the app. */
export const projectSymbols = {
  labels: new Set<string>(),
  bibKeys: new Set<string>(),
}

type LibraryItem = { citekey: string; title: string; authors: string[]; year: number | null }
let zoteroItems: () => LibraryItem[] = () => []
let onZoteroPick: (key: string) => void = () => {}

/** Let \cite completion offer the Zotero library; `onPick` adds a chosen item's entry to the project. */
export function setZoteroSource(items: () => LibraryItem[], onPick: (key: string) => void) {
  zoteroItems = items
  onZoteroPick = onPick
}

function argumentCompletions(context: CompletionContext): CompletionResult | null {
  // \cmd[opt]{partial  — find which command's brace argument the cursor is in
  const match = context.matchBefore(/\\([a-zA-Z]+\*?)(?:\[[^\]]*\])?\{([^{}]*)$/)
  if (!match) return null
  const command = match.text.match(/^\\([a-zA-Z]+\*?)/)![1]
  const argText = match.text.slice(match.text.lastIndexOf('{') + 1)
  // for comma-separated lists like \cite{a,b,|} only complete the last item
  const from = match.to - (argText.length - argText.lastIndexOf(',') - 1)

  let options: string[] | null = null
  let type = 'constant'
  if (command === 'begin' || command === 'end') options = environmentNames
  else if (command === 'usepackage' || command === 'RequirePackage') options = packageNames
  else if (command === 'documentclass') options = classNames
  else if (/^(ref|eqref|autoref|cref|Cref|pageref|nameref)\*?$/.test(command)) {
    // saved project labels plus any typed into the open document since the last save
    const live = [...context.state.doc.toString().matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1])
    options = [...new Set([...projectSymbols.labels, ...live])]
    type = 'variable'
  } else if (/cite/i.test(command)) {
    // the project's own keys first, then the rest of the Zotero library
    const own = [...projectSymbols.bibKeys].map(label => ({ label, type: 'variable', boost: 1 }) as Completion)
    const lib: Completion[] = zoteroItems()
      .filter(i => !projectSymbols.bibKeys.has(i.citekey))
      .map(i => ({
        label: i.citekey,
        type: 'text',
        detail: `${i.authors[0] ?? ''}${i.authors.length > 1 ? ' et al.' : ''} ${i.year ?? ''} · Zotero`,
        info: i.title,
        apply: (view, _c, f, t) => {
          view.dispatch({ changes: { from: f, to: t, insert: i.citekey }, selection: { anchor: f + i.citekey.length } })
          onZoteroPick(i.citekey) // not in the .bib yet: bring its entry over
        },
      }))
    return { from, options: [...own, ...lib], validFor: /^[^{},\s]*$/ }
  }
  if (!options) return null
  return {
    from,
    options: options.map(label => ({ label, type })),
    validFor: /^[^{},\s]*$/,
  }
}

export function latexCompletions(context: CompletionContext): CompletionResult | null {
  const arg = argumentCompletions(context)
  if (arg) return arg
  const word = context.matchBefore(/\\[a-zA-Z@]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  return { from: word.from, options: commandCompletions, validFor: /^\\[a-zA-Z@]*$/ }
}

/** Scan project text for \label{} and .bib entries so \ref and \cite can complete them. */
export function indexProjectText(path: string, text: string) {
  if (path.endsWith('.bib')) {
    for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)) {
      if (!/^(comment|string|preamble)$/i.test(m[1])) projectSymbols.bibKeys.add(m[2])
    }
  } else {
    for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) projectSymbols.labels.add(m[1])
  }
}
