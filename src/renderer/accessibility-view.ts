// The Accessibility view of the Review tab: runs the check (no AI needed), lists what it found with
// one-click fixes, and underlines the places in the editor. Alt text can be suggested by the vision model.
import { A11yIssue, checkAccessibility, withAlt, withHeaderRule, withMetadata } from './accessibility'
import { EditorView } from '@codemirror/view'
import { featureReady, runAi } from './ai-client'
import type { AppHost } from './host'

type Bridge = { readBinary(root: string, rel: string): Promise<string | null> }
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

let issues: A11yIssue[] = []
let checked = false
let busy = false

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => Object.assign(document.createElement(tag), { className: cls, textContent: text })

/** Check the whole project; `onDone` re-renders the view. */
export async function runAccessibilityCheck(host: AppHost, onDone: () => void) {
  if (busy || !host.root()) return
  busy = true
  try {
    const main = host.mainFile() ?? ''
    const sources = await Promise.all(host.files().filter(f => f.path.endsWith('.tex')).map(async f => ({ path: f.path, text: await host.fileText(f.path) })))
    issues = checkAccessibility(sources, main)
    checked = true
    // underline the places, per file
    for (const s of sources) {
      const mine = issues.filter(i => i.file === s.path)
      host.setAiDiagnostics(s.path, mine.map(i => ({ find: s.text.slice(i.from, i.to), message: `Accessibility: ${i.title}`, severity: i.severity === 'problem' ? 'warning' : 'info' })), 'Accessibility')
    }
  } finally {
    busy = false
    onDone()
  }
}

export const accessibilityCount = () => issues.filter(i => i.severity !== 'tip').length

export function accessibilityView(host: AppHost, rerender: () => void): HTMLElement[] {
  const out: HTMLElement[] = []
  const bar = el('div', 'rv-lt')
  const run = el('button', 'primary', checked ? 'Check again' : 'Check accessibility')
  run.onclick = () => void runAccessibilityCheck(host, rerender)
  const summary = el('span', 'muted')
  if (checked) {
    const n = (s: A11yIssue['severity']) => issues.filter(i => i.severity === s).length
    summary.textContent = issues.length ? `${n('problem')} problem${n('problem') === 1 ? '' : 's'}, ${n('warning')} warning${n('warning') === 1 ? '' : 's'}, ${n('tip')} tip${n('tip') === 1 ? '' : 's'}` : '✓ Nothing found'
  } else summary.textContent = 'Finds what makes the PDF hard to use with a screen reader or for people with low vision.'
  bar.append(run, summary)
  out.push(bar)
  if (!checked) {
    // the first look at the view runs it (it takes a moment, and needs no AI)
    void runAccessibilityCheck(host, rerender)
    return out
  }
  for (const i of issues) {
    const card = el('div', `rv-card a11y ${i.severity}`)
    const head = el('div', 'rv-card-head')
    head.append(el('span', 'rv-issue-type', i.severity === 'problem' ? 'problem' : i.severity), el('strong', '', i.title))
    const loc = el('div', 'rv-quote', `${i.file}`)
    loc.onclick = () => void show(host, i)
    card.append(head, el('div', 'a11y-detail', i.detail), loc)
    const actions = el('div', 'a11y-actions')
    for (const b of fixButtons(host, i, rerender)) actions.append(b)
    if (actions.childElementCount) card.append(actions)
    out.push(card)
  }
  if (!issues.length) out.push(el('div', 'muted rv-hint', 'No accessibility problems found in the LaTeX. Pictures have descriptions, the PDF has a title and language, and colours have enough contrast.'))
  return out
}

async function show(host: AppHost, i: A11yIssue) {
  await host.openFile(i.file)
  host.view.dispatch({ selection: { anchor: i.from, head: i.to }, scrollIntoView: true })
  host.view.focus()
}

/** Apply a text change to a file through the editor (undoable), then check again. */
async function edit(host: AppHost, file: string, change: (text: string) => string, rerender: () => void, what: string) {
  const before = await host.fileText(file)
  const after = change(before)
  if (after === before) return
  await host.applyFileText(file, after)
  // show what changed: open the file with the new text selected
  let start = 0
  while (start < before.length && before[start] === after[start]) start++
  let end = after.length
  let endBefore = before.length
  while (end > start && endBefore > start && after[end - 1] === before[endBefore - 1]) end--, endBefore--
  await host.openFile(file)
  host.view.dispatch({ selection: { anchor: start, head: end }, effects: EditorView.scrollIntoView(start, { y: 'center' }) })
  host.view.focus()
  host.setStatus(`${what}: the added text is selected (Ctrl+Z undoes it)`, 'ok')
  await runAccessibilityCheck(host, rerender)
}

function fixButtons(host: AppHost, i: A11yIssue, rerender: () => void): HTMLButtonElement[] {
  const b = (label: string, run: () => void, cls = '') => {
    const x = el('button', cls, label)
    x.onclick = ev => (ev.stopPropagation(), run())
    return x
  }
  const f = i.fix
  if (!f) return []
  switch (f.kind) {
    case 'alt': {
      const describe = async (suggest: string) => {
        const alt = await host.format.prompt(`Describe ${f.image} in a sentence (what someone who can’t see it needs to know)`, suggest)
        if (alt) await edit(host, i.file, t => withAlt(t, i.from, alt), rerender, 'Added a description to the picture')
      }
      const ai = b('✦ Suggest with AI', async () => {
        ai.disabled = true
        ai.textContent = 'Looking at the picture…'
        try {
          await describe(await suggestAlt(host, i.file, f.image))
        } catch (e) {
          host.setStatus(`Couldn’t describe the picture: ${(e as Error).message}`, 'error')
        } finally {
          ai.disabled = false
          ai.textContent = '✦ Suggest with AI'
        }
      })
      ai.hidden = true
      void featureReady('vision').then(ok => (ai.hidden = !ok))
      return [b('Add description', () => void describe(''), 'primary'), ai]
    }
    case 'metadata':
      return [b('Add title and language', () => void edit(host, i.file, t => withMetadata(t, f.title), rerender, 'Added the PDF title and language'), 'primary')]
    case 'link':
      return [b(f.label, () => window.open(f.url, '_blank'))]
    case 'header-rule':
      return [b('Add a rule under the first row', () => void edit(host, i.file, t => withHeaderRule(t, f.at), rerender, 'Marked the header row'), 'primary')]
    case 'replace':
      return [b(f.label, () => void edit(host, i.file, t => t.slice(0, f.from) + f.text + t.slice(f.to), rerender, f.label), 'primary')]
  }
}

/** Ask the vision model for alt text for a project picture (PNG/JPG). */
async function suggestAlt(host: AppHost, file: string, image: string): Promise<string> {
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : ''
  const candidates = ['', '.png', '.jpg', '.jpeg'].map(ext => `${dir}${image}${ext}`.replace(/^\.\//, ''))
  const found = candidates.find(c => host.files().some(f => f.path === c && /\.(png|jpe?g)$/i.test(c)))
  if (!found) throw new Error('only PNG and JPG pictures can be described')
  const base64 = await bridge.readBinary(host.root()!, found)
  if (!base64) throw new Error('the picture couldn’t be read')
  const r = await runAi({
    feature: 'vision',
    images: [{ mediaType: /\.png$/i.test(found) ? 'image/png' : 'image/jpeg', base64 }],
    messages: [{ role: 'user', content: 'Write alt text for this figure from a document: one plain sentence (under 140 characters) saying what it shows and its main point. No "image of". Reply with the sentence only.' }],
    maxTokens: 120,
  }).result
  return r.text.replace(/^["“]|["”]$/g, '').trim()
}
