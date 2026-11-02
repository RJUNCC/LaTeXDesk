// The Comments tab: comments and suggested changes for the open file, with Accept / Reject, replies and
// resolving, plus the Suggest switch. Everything is saved in .texdesk/review.json, so it travels with the
// project folder (zip it, or share it through OneDrive or Dropbox) and isn't part of the submission export.
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { AppHost } from './host'
import { panelEl, setBadge, showPanel, whenShown } from './panels'
import {
  Comment,
  FileReview,
  acceptChanges,
  addComment,
  authorColor,
  hasReview,
  rejectChanges,
  restore,
  reviewField,
  reviewOf,
  serialize,
  setSuggesting,
  suggesting,
  timeAgo,
  trackChanges,
  updateComments,
} from './track-changes'

const STORE = '.texdesk/review.json'

type Deps = { stateOf(path: string): EditorState | undefined; author(): Promise<string> }

let host: AppHost
let deps: Deps
let store: Record<string, FileReview> = {}
let saved = ''
let showResolved = false
// a comment being written (from Add comment), shown at the top of the list
let draft: { from: number; to: number; quote: string } | null = null

const $ = <T extends HTMLElement>(sel: string) => panelEl('comments').querySelector<T>(sel)!

export function initComments(h: AppHost, d: Deps) {
  host = h
  deps = d
  panelEl('comments').innerHTML = `
    <div class="pane-title cm-head">
      <label class="toggle cm-suggest" title="While on, your edits are suggestions that can be accepted or rejected (track changes)"><input type="checkbox" class="cm-suggest-box"> Suggest changes</label>
      <div class="spacer"></div>
      <button class="cm-add" title="Comment on the selected text (Ctrl+Alt+M)">💬 Comment</button>
    </div>
    <div class="cm-bulk" hidden><span class="muted cm-bulk-count"></span><div class="spacer"></div><button class="cm-accept-all">✓ Accept all</button><button class="cm-reject-all">✗ Reject all</button></div>
    <div class="cm-list"></div>
    <div class="cm-foot"><label class="check muted"><input type="checkbox" class="cm-show-resolved"> Show resolved comments</label><span class="muted cm-elsewhere"></span></div>`
  $<HTMLInputElement>('.cm-suggest-box').onchange = ev => void setSuggest((ev.target as HTMLInputElement).checked)
  $('.cm-add').onclick = () => void startComment()
  $<HTMLInputElement>('.cm-show-resolved').onchange = ev => ((showResolved = (ev.target as HTMLInputElement).checked), render())
  $('.cm-accept-all').onclick = () => {
    const ids = reviewOf(host.view.state).changes.map(c => c.id)
    if (ids.length && confirm(`Accept all ${ids.length} suggested change${ids.length > 1 ? 's' : ''} in ${host.currentPath()}?`)) acceptChanges(host.view, ids)
  }
  $('.cm-reject-all').onclick = () => {
    const ids = reviewOf(host.view.state).changes.map(c => c.id)
    if (ids.length && confirm(`Reject all ${ids.length} suggested change${ids.length > 1 ? 's' : ''} in ${host.currentPath()}? Suggested text is removed and deleted text comes back.`)) rejectChanges(host.view, ids)
  }
  whenShown('comments', render)
}

// ---------- the Suggest switch ----------

export async function setSuggest(on: boolean) {
  setSuggesting(on ? await deps.author() : null)
  document.body.classList.toggle('suggesting', on)
  const box = panelEl('comments').querySelector<HTMLInputElement>('.cm-suggest-box')
  if (box) box.checked = on
  const btn = document.getElementById('suggest-btn')
  btn?.classList.toggle('active', on)
  if (btn) btn.title = on ? 'Suggesting: your edits are recorded as suggestions. Click to edit normally.' : 'Suggest changes (track changes)'
  host.setStatus(on ? 'Suggesting: your edits are shown as suggestions others can accept or reject' : 'Editing normally', 'ok')
}

export const toggleSuggest = () => setSuggest(!suggesting())

// ---------- loading and saving ----------

/** Read the project's comments and suggestions (before any file is opened). */
export async function loadReview() {
  const raw = await host.readProjectFile(STORE)
  try {
    store = raw ? JSON.parse(raw).files ?? {} : {}
  } catch {
    store = {}
  }
  saved = raw ?? ''
}

/** The editor extension for a file: its saved comments and suggestions, fitted to its current text. */
export function reviewExtension(path: string, doc: string) {
  return [
    trackChanges(restore(doc, store[path])),
    EditorView.updateListener.of(u => {
      if (u.startState.field(reviewField, false) !== u.state.field(reviewField, false)) changed()
    }),
  ]
}

/** A file's comments and suggestions, positioned in `text` (its current contents). */
export function reviewFor(path: string, text: string): FileReview {
  const state = deps.stateOf(path)
  if (state?.field(reviewField, false) && state.doc.toString() === text) return reviewOf(state)
  return restore(text, store[path])
}

let saveTimer: number | undefined
function changed() {
  render()
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void persist(), 800)
}

/** Save every open file's comments and suggestions (also called whenever files are saved). */
export async function persist() {
  clearTimeout(saveTimer)
  if (!host.root()) return
  const paths = new Set([...Object.keys(store), ...host.files().map(f => f.path)])
  for (const path of paths) {
    const state = deps.stateOf(path)
    if (!state?.field(reviewField, false)) continue
    const data = serialize(state)
    if (hasReview(data)) store[path] = data
    else delete store[path]
  }
  const json = JSON.stringify({ version: 1, files: store }, null, 1)
  if (json === saved || (!saved && !Object.keys(store).length)) return
  saved = json
  await host.writeProjectFile(STORE, json)
}

// ---------- comments ----------

/** Comment on the selection (Ctrl+Alt+M, the 💬 button, or Review → Add Comment). */
export async function startComment() {
  const sel = host.view.state.selection.main
  if (!host.currentPath()) return
  if (sel.empty) {
    host.setStatus('Select the text you want to comment on, then click Comment', 'warn')
    return
  }
  draft = { from: sel.from, to: sel.to, quote: host.view.state.sliceDoc(sel.from, sel.to) }
  showPanel('comments')
  render()
  $<HTMLTextAreaElement>('.cm-draft textarea')?.focus()
}

function select(from: number, to: number) {
  host.view.dispatch({ selection: { anchor: from, head: to }, effects: EditorView.scrollIntoView(from, { y: 'center' }) })
  host.view.focus()
}

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function personLine(author: string, date: number, extra = '') {
  const head = document.createElement('div')
  head.className = 'cm-who'
  head.innerHTML = '<span class="tc-dot"></span><strong></strong> <span class="muted"></span>'
  head.querySelector<HTMLElement>('.tc-dot')!.style.background = authorColor(author)
  head.querySelector('strong')!.textContent = author
  head.querySelector('.muted')!.textContent = `${extra}${extra ? ' · ' : ''}${timeAgo(date)}`
  return head
}

function button(label: string, run: () => void, cls = '') {
  const b = Object.assign(document.createElement('button'), { textContent: label, className: cls })
  b.onclick = ev => (ev.stopPropagation(), run())
  return b
}

function draftCard() {
  const card = document.createElement('div')
  card.className = 'cm-card cm-draft'
  const quote = Object.assign(document.createElement('div'), { className: 'cm-quote', textContent: short(draft!.quote) })
  const input = document.createElement('textarea')
  input.placeholder = 'Write a comment… (Ctrl+Enter to post)'
  input.rows = 3
  const post = async () => {
    const text = input.value.trim()
    if (!text || !draft) return
    addComment(host.view, await deps.author(), text, draft)
    draft = null
    render()
  }
  input.onkeydown = ev => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) void post()
    if (ev.key === 'Escape') ((draft = null), render())
  }
  const actions = document.createElement('div')
  actions.className = 'cm-actions'
  actions.append(button('Comment', () => void post(), 'primary'), button('Cancel', () => ((draft = null), render())))
  card.append(quote, input, actions)
  return card
}

function commentCard(c: Comment) {
  const card = document.createElement('div')
  card.className = `cm-card cm-comment${c.resolved ? ' resolved' : ''}`
  card.dataset.comment = c.id
  card.onclick = () => c.to > c.from && select(c.from, c.to)
  card.append(personLine(c.author, c.date, c.resolved ? 'resolved' : ''))
  const quote = Object.assign(document.createElement('div'), { className: 'cm-quote', textContent: c.to > c.from ? short(host.view.state.sliceDoc(c.from, c.to)) : `“${short(c.quote, 80)}” (this text was deleted)` })
  const body = Object.assign(document.createElement('div'), { className: 'cm-text', textContent: c.text })
  card.append(quote, body)
  for (const r of c.replies) {
    const reply = document.createElement('div')
    reply.className = 'cm-reply'
    reply.append(personLine(r.author, r.date), Object.assign(document.createElement('div'), { className: 'cm-text', textContent: r.text }))
    card.append(reply)
  }
  const actions = document.createElement('div')
  actions.className = 'cm-actions'
  const replyBox = document.createElement('div')
  replyBox.className = 'cm-reply-box'
  replyBox.hidden = true
  const input = document.createElement('textarea')
  input.rows = 2
  input.placeholder = 'Reply… (Ctrl+Enter)'
  input.onclick = ev => ev.stopPropagation()
  const sendReply = async () => {
    const text = input.value.trim()
    if (!text) return
    const reply = { id: crypto.randomUUID().slice(0, 8), author: await deps.author(), date: Date.now(), text }
    updateComments(host.view, list => list.map(x => (x.id === c.id ? { ...x, replies: [...x.replies, reply] } : x)))
  }
  input.onkeydown = ev => ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && void sendReply()
  replyBox.append(input, button('Reply', () => void sendReply(), 'primary'))
  actions.append(
    button('Reply', () => ((replyBox.hidden = false), input.focus())),
    button(c.resolved ? 'Reopen' : '✓ Resolve', () => updateComments(host.view, list => list.map(x => (x.id === c.id ? { ...x, resolved: !c.resolved } : x)))),
    button('Delete', () => confirm('Delete this comment and its replies?') && updateComments(host.view, list => list.filter(x => x.id !== c.id)))
  )
  card.append(replyBox, actions)
  return card
}

function render() {
  const list = panelEl('comments').querySelector('.cm-list')
  if (!list) return
  const path = host.currentPath()
  const review = path ? reviewOf(host.view.state) : { comments: [], changes: [] }
  const open = review.comments.filter(c => !c.resolved)
  const resolved = review.comments.filter(c => c.resolved)
  // in the order they appear in the file
  type Item = { at: number; el: () => HTMLElement }
  const items: Item[] = [
    ...(showResolved ? review.comments : open).map(c => ({ at: c.from, el: () => commentCard(c) })),
    ...review.changes.map(ch => ({
      at: ch.from,
      el: () => {
        const card = document.createElement('div')
        card.className = `cm-card cm-change ${ch.kind}`
        card.dataset.change = ch.id
        card.onclick = () => select(ch.from, ch.to)
        card.append(personLine(ch.author, ch.date, ch.kind === 'insert' ? 'added' : 'deleted'))
        const text = Object.assign(document.createElement('div'), { className: `cm-change-text ${ch.kind}`, textContent: short(ch.kind === 'insert' ? host.view.state.sliceDoc(ch.from, ch.to) : ch.text, 200) })
        text.style.setProperty('--tc-color', authorColor(ch.author))
        const actions = document.createElement('div')
        actions.className = 'cm-actions'
        actions.append(button('✓ Accept', () => acceptChanges(host.view, [ch.id]), 'primary'), button('✗ Reject', () => rejectChanges(host.view, [ch.id])))
        card.append(text, actions)
        return card
      },
    })),
  ].sort((a, b) => a.at - b.at)
  const cards = items.map(i => i.el())
  if (draft) cards.unshift(draftCard())
  if (!cards.length) {
    const empty = document.createElement('div')
    empty.className = 'cm-empty muted'
    empty.innerHTML = path
      ? `<p>No comments or suggestions in ${path.replace(/[<>&]/g, '')}${resolved.length ? ` (${resolved.length} resolved)` : ''}.</p><p><b>To comment:</b> select some text and click 💬 Comment (Ctrl+Alt+M).</p><p><b>To suggest changes:</b> turn on <i>Suggest changes</i>, then edit as usual. Your edits are shown to others to accept or reject, like Track Changes in Word.</p><p>Share the whole project folder (including its hidden <code>.texdesk</code> folder) and everyone sees the same comments.</p>`
      : '<p>Open a file to see its comments.</p>'
    cards.push(empty)
  }
  list.replaceChildren(...cards)
  const n = review.changes.length
  $('.cm-bulk').hidden = n === 0
  $('.cm-bulk-count').textContent = `${n} suggestion${n === 1 ? '' : 's'}`
  // other files with open items
  const elsewhere = Object.entries(store).filter(([p, r]) => p !== path && (r.changes.length || r.comments.some(c => !c.resolved)))
  $('.cm-elsewhere').textContent = elsewhere.length ? `Also in: ${elsewhere.map(([p]) => p).join(', ')}` : ''
  setBadge('comments', open.length + n)
}

/** Refresh after switching files. */
export const refreshComments = () => render()
