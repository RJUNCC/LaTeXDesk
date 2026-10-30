// The Tasks tab: a per-project to-do list (saved in .texdesk/tasks.json) plus every `% TODO:` comment in
// the project. Any task can be run by the AI, which proposes edits that go through the diff review.
import { extractJson, featureReady, runAi } from './ai-client'
import { EDIT_RULES, SYSTEM, applyEdits } from './ai-panel'
import type { FindReplace } from './diff-review'
import type { AppHost } from './host'
import { panelEl, setBadge, showPanel, whenShown } from './panels'

type Task = { id: string; text: string; done: boolean; created: number }
type Todo = { file: string; line: number; text: string; raw: string }

const STORE = '.texdesk/tasks.json'
const TODO_RE = /^[ \t]*%+[ \t]*TODO\b[:\s]*(.*)$/gim

let host: AppHost
let tasks: Task[] = []
let todos: Todo[] = []
let running: string | null = null
let cancelRun: (() => void) | null = null

const $ = <T extends HTMLElement>(sel: string) => panelEl('tasks').querySelector<T>(sel)!

export function initTasks(h: AppHost) {
  host = h
  panelEl('tasks').innerHTML = `
    <div class="pane-title tasks-add">
      <input class="task-input" placeholder="Add a task, e.g. “Add a limitations paragraph to the discussion”">
      <button class="primary task-add-btn">Add</button>
    </div>
    <div class="tasks-body">
      <div class="tasks-list"></div>
      <h4 class="tasks-h">From % TODO comments <span class="muted tasks-todo-count"></span></h4>
      <div class="todos-list"></div>
      <details class="tasks-done"><summary>Done <span class="muted tasks-done-count"></span></summary><div class="done-list"></div></details>
    </div>
    <div class="tasks-status muted"></div>`
  const input = $<HTMLInputElement>('.task-input')
  const add = () => {
    const text = input.value.trim()
    if (!text) return
    tasks.unshift({ id: crypto.randomUUID(), text, done: false, created: Date.now() })
    input.value = ''
    void persist()
  }
  input.onkeydown = ev => ev.key === 'Enter' && add()
  $('.task-add-btn').onclick = add
  host.onProjectOpened(() => void load())
  host.onCompiled(() => void scanTodos())
  whenShown('tasks', () => void scanTodos())
}

async function load() {
  const raw = await host.readProjectFile(STORE)
  try {
    tasks = raw ? (JSON.parse(raw) as Task[]) : []
  } catch {
    tasks = []
  }
  await scanTodos()
}

/** Add tasks from another tab (e.g. unproved proof steps), keeping their order at the top of the list. */
export async function addTasks(texts: string[]) {
  tasks.unshift(...texts.map(text => ({ id: crypto.randomUUID(), text, done: false, created: Date.now() })))
  await persist()
}

async function persist() {
  await host.writeProjectFile(STORE, JSON.stringify(tasks, null, 2))
  render()
}

/** Collect `% TODO: …` comments from every .tex file in the project. */
async function scanTodos() {
  const found: Todo[] = []
  for (const f of host.files()) {
    if (!f.path.endsWith('.tex')) continue
    const text = await host.fileText(f.path)
    for (const m of text.matchAll(TODO_RE)) {
      const line = text.slice(0, m.index).split('\n').length
      found.push({ file: f.path, line, text: m[1].trim() || '(no description)', raw: m[0] })
    }
  }
  todos = found
  render()
}

function button(label: string, title: string, onClick: () => void, cls = '') {
  const b = document.createElement('button')
  b.textContent = label
  b.title = title
  b.className = cls
  b.onclick = ev => {
    ev.stopPropagation()
    onClick()
  }
  return b
}

function runButton(key: string, run: () => void) {
  const active = running === key
  return button(active ? '■ Stop' : '▶ Run with AI', active ? 'Stop the AI' : 'Let the AI propose edits for this task', active ? stopRun : run, `task-run${active ? ' active' : ''}`)
}

function render() {
  const open = tasks.filter(t => !t.done)
  const done = tasks.filter(t => t.done)
  $('.tasks-list').replaceChildren(
    ...(open.length
      ? open.map((t, i) => {
          const row = document.createElement('div')
          row.className = 'task'
          const box = document.createElement('input')
          box.type = 'checkbox'
          box.onchange = () => ((t.done = true), void persist())
          const label = document.createElement('span')
          label.className = 'task-text'
          label.textContent = t.text
          label.title = 'Double-click to edit'
          // edit in place (Electron has no window.prompt): Enter or leaving the field saves, Esc cancels
          label.ondblclick = () => {
            label.contentEditable = 'plaintext-only'
            label.focus()
            getSelection()?.selectAllChildren(label)
            const finish = (keep: boolean) => {
              label.contentEditable = 'false'
              const text = label.textContent?.trim()
              if (keep && text && text !== t.text) (t.text = text), void persist()
              else label.textContent = t.text
            }
            label.onkeydown = ev => {
              if (ev.key === 'Enter') (ev.preventDefault(), finish(true))
              if (ev.key === 'Escape') finish(false)
            }
            label.onblur = () => finish(true)
          }
          row.append(
            box,
            label,
            runButton(t.id, () => void runTask(t.id, t.text)),
            button('↑', 'Move up', () => {
              const at = tasks.indexOf(t)
              const prev = tasks.slice(0, at).reverse().find(x => !x.done)
              if (!prev || i === 0) return
              const pi = tasks.indexOf(prev)
              ;[tasks[pi], tasks[at]] = [tasks[at], tasks[pi]]
              void persist()
            }, 'icon'),
            button('✕', 'Delete', () => ((tasks = tasks.filter(x => x !== t)), void persist()), 'icon')
          )
          return row
        })
      : [Object.assign(document.createElement('div'), { className: 'muted tasks-empty', textContent: 'No tasks yet.' })])
  )
  $('.tasks-todo-count').textContent = todos.length ? `(${todos.length})` : '(none)'
  $('.todos-list').replaceChildren(
    ...todos.map(td => {
      const row = document.createElement('div')
      row.className = 'task todo'
      const loc = document.createElement('span')
      loc.className = 'task-loc'
      loc.textContent = `${td.file}:${td.line}`
      const label = document.createElement('span')
      label.className = 'task-text'
      label.textContent = td.text
      row.onclick = () => host.openFile(td.file, td.line)
      row.append(label, loc, runButton(`todo:${td.file}:${td.line}`, () => void runTodo(td)))
      return row
    })
  )
  $('.tasks-done-count').textContent = `(${done.length})`
  $('.done-list').replaceChildren(
    ...done.map(t => {
      const row = document.createElement('div')
      row.className = 'task done'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = true
      box.onchange = () => ((t.done = false), void persist())
      const label = document.createElement('span')
      label.className = 'task-text'
      label.textContent = t.text
      row.append(box, label, button('✕', 'Delete', () => ((tasks = tasks.filter(x => x !== t)), void persist()), 'icon'))
      return row
    })
  )
  setBadge('tasks', open.length + todos.length)
}

function status(text: string) {
  $('.tasks-status').textContent = text
}

function stopRun() {
  cancelRun?.()
  cancelRun = null
  running = null
  status('Stopped.')
  render()
}

/** Files the AI gets to see for a task: the one it mentions, the open file, and the main document. */
async function taskContext(extra?: string) {
  const picked = [extra, host.currentPath(), host.mainFile()].filter((p, i, a): p is string => !!p && a.indexOf(p) === i)
  let out = ''
  for (const p of picked) {
    if (!host.fileExists(p)) continue
    const t = await host.fileText(p)
    if (out.length + t.length > 50000) break
    out += `File ${p}:\n\`\`\`latex\n${t}\n\`\`\`\n\n`
  }
  const others = host.files().filter(f => f.editable && !picked.includes(f.path)).map(f => f.path)
  if (others.length) out += `Other project files (not shown): ${others.join(', ')}\n`
  return out
}

/** Ask the AI for edits that accomplish `instruction`; returns how many were applied after review. */
async function runWithAi(key: string, instruction: string, contextFile?: string) {
  if (running) return 0
  if (!(await featureReady('tasks'))) {
    status('No AI model is set up for tasks. Open ⚙ (AI settings) to pick one.')
    return 0
  }
  running = key
  render()
  status('The AI is working on it…')
  const job = runAi({
    feature: 'tasks',
    system: SYSTEM,
    messages: [{ role: 'user', content: `${await taskContext(contextFile)}\nTask: ${instruction}\n\n${EDIT_RULES}` }],
    maxTokens: 6000,
    json: true,
  })
  cancelRun = job.cancel
  try {
    const r = await job.result
    const data = extractJson<{ summary?: string; edits?: (FindReplace & { why?: string })[] }>(r.text)
    if (!data) {
      status('The AI answer was not valid JSON, so nothing was proposed. Try again, or a stronger model in ⚙.')
      return 0
    }
    const edits = (data.edits ?? []).filter(e => e && typeof e.find === 'string' && typeof e.replace === 'string')
    if (!edits.length) {
      status(data.summary ? `No edits proposed: ${data.summary}` : 'No edits proposed.')
      return 0
    }
    status(data.summary ?? '')
    return await applyEdits(edits.map(e => ({ ...e, file: e.file || contextFile || host.currentPath() || '' })), `Task: ${instruction.slice(0, 80)}`)
  } catch (e) {
    const msg = (e as Error).message || String(e)
    if (!/abort/i.test(msg)) status(`⚠ ${msg}`)
    return 0
  } finally {
    running = null
    cancelRun = null
    render()
  }
}

async function runTask(id: string, text: string) {
  const applied = await runWithAi(id, text)
  if (applied > 0) {
    const t = tasks.find(x => x.id === id)
    if (t) t.done = true
    await persist()
    status(`Done: applied ${applied} change${applied > 1 ? 's' : ''}. Ctrl+Z in the editor undoes them.`)
  }
}

async function runTodo(td: Todo) {
  const applied = await runWithAi(
    `todo:${td.file}:${td.line}`,
    `${td.text}\n(This comes from the comment "${td.raw.trim()}" at ${td.file}:${td.line}. Do the work, and as part of your edits replace that TODO comment line with the new content.)`,
    td.file
  )
  if (applied > 0) {
    showPanel('tasks')
    await scanTodos()
  }
}
