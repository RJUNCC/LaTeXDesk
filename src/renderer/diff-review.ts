// Review proposed file changes hunk by hunk; nothing is written until the user applies it.
import { applyPatch, structuredPatch, type StructuredPatch } from 'diff'

export type FileChange = { file: string; before: string; after: string }
/** An AI-style edit: replace the one occurrence of `find` (empty `find` appends to the file). */
export type FindReplace = { file: string; find: string; replace: string }

export type ReviewHost = {
  fileText(path: string): Promise<string>
  /** Write new text for a file (through the editor if it's open, so it's undoable). */
  applyFileText(path: string, text: string): Promise<void>
  fileExists(path: string): boolean
}

/** Turn find/replace edits into whole-file changes. Edits whose `find` is missing or ambiguous are reported. */
export async function editsToChanges(edits: FindReplace[], host: ReviewHost) {
  const texts = new Map<string, string>()
  const problems: string[] = []
  for (const e of edits) {
    const file = e.file.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!texts.has(file)) texts.set(file, host.fileExists(file) ? await host.fileText(file) : '')
    const text = texts.get(file)!
    if (!e.find) {
      texts.set(file, text + (text.endsWith('\n') || !text ? '' : '\n') + e.replace)
      continue
    }
    const at = text.indexOf(e.find)
    if (at < 0) {
      problems.push(`${file}: couldn't find the text to replace ("${e.find.slice(0, 60)}…")`)
      continue
    }
    if (text.indexOf(e.find, at + 1) >= 0) {
      problems.push(`${file}: the text to replace appears more than once ("${e.find.slice(0, 60)}…")`)
      continue
    }
    texts.set(file, text.slice(0, at) + e.replace + text.slice(at + e.find.length))
  }
  const changes: FileChange[] = []
  for (const [file, after] of texts) {
    const before = host.fileExists(file) ? await host.fileText(file) : ''
    if (before !== after) changes.push({ file, before, after })
  }
  return { changes, problems }
}

let dialog: HTMLDialogElement | null = null

function buildDialog() {
  const dlg = document.createElement('dialog')
  dlg.id = 'diff-dialog'
  dlg.className = 'wide diff-review'
  dlg.innerHTML = `
    <h3 class="dr-title">Review changes</h3>
    <p class="muted dr-summary"></p>
    <div class="dr-problems"></div>
    <div class="dr-files"></div>
    <menu>
      <button type="button" class="dr-all">Select all</button>
      <button type="button" class="dr-none">Select none</button>
      <span class="spacer"></span>
      <button type="button" class="primary dr-apply">Apply selected</button>
      <button type="button" class="dr-cancel">Cancel</button>
    </menu>`
  document.body.appendChild(dlg)
  return dlg
}

/**
 * Show the changes; resolve to the number of hunks applied (0 if cancelled).
 * Each hunk can be accepted or rejected independently.
 */
export function reviewChanges(title: string, changes: FileChange[], host: ReviewHost, problems: string[] = []): Promise<number> {
  dialog ??= buildDialog()
  const dlg = dialog
  const q = <T extends Element>(s: string) => dlg.querySelector<T>(s)!
  q('.dr-title').textContent = title
  // 1 line of context keeps nearby edits in separate, separately approvable hunks
  const patches = changes.map(c => ({ change: c, patch: structuredPatch(c.file, c.file, c.before, c.after, '', '', { context: 1 }) as StructuredPatch }))
  const total = patches.reduce((n, p) => n + p.patch.hunks.length, 0)
  q('.dr-summary').textContent = total
    ? `${total} change${total > 1 ? 's' : ''} in ${patches.length} file${patches.length > 1 ? 's' : ''}. Untick anything you don't want, then Apply.`
    : 'No changes were proposed.'
  q('.dr-problems').replaceChildren(
    ...problems.map(p => {
      const d = document.createElement('div')
      d.className = 'dr-problem'
      d.textContent = `⚠ ${p}`
      return d
    })
  )

  const boxes: { file: number; hunk: number; box: HTMLInputElement }[] = []
  q('.dr-files').replaceChildren(
    ...patches.map(({ change, patch }, fi) => {
      const sec = document.createElement('section')
      const h = document.createElement('h4')
      h.textContent = change.before ? change.file : `${change.file} (new file)`
      sec.appendChild(h)
      patch.hunks.forEach((hunk, hi) => {
        const wrap = document.createElement('label')
        wrap.className = 'dr-hunk'
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = true
        boxes.push({ file: fi, hunk: hi, box })
        const pre = document.createElement('pre')
        for (const line of hunk.lines) {
          const span = document.createElement('span')
          span.className = line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : 'ctx'
          span.textContent = line + '\n'
          pre.appendChild(span)
        }
        const where = document.createElement('div')
        where.className = 'dr-where'
        where.textContent = `line ${hunk.oldStart}`
        wrap.append(box, where, pre)
        sec.appendChild(wrap)
      })
      return sec
    })
  )
  q<HTMLButtonElement>('.dr-apply').disabled = total === 0
  q<HTMLButtonElement>('.dr-all').onclick = () => boxes.forEach(b => (b.box.checked = true))
  q<HTMLButtonElement>('.dr-none').onclick = () => boxes.forEach(b => (b.box.checked = false))

  return new Promise(resolve => {
    let settled = false
    const finish = (n: number) => {
      if (settled) return
      settled = true
      dlg.close()
      resolve(n)
    }
    q<HTMLButtonElement>('.dr-cancel').onclick = () => finish(0)
    dlg.oncancel = () => finish(0)
    q<HTMLButtonElement>('.dr-apply').onclick = async () => {
      let applied = 0
      for (const [fi, { change, patch }] of patches.entries()) {
        const keep = patch.hunks.filter((_, hi) => boxes.find(b => b.file === fi && b.hunk === hi)!.box.checked)
        if (!keep.length) continue
        // re-read: the file may have changed while the dialog was open; applyPatch refuses if it no longer fits
        const current = host.fileExists(change.file) ? await host.fileText(change.file) : ''
        const result = applyPatch(current, { ...patch, hunks: keep })
        if (result === false) {
          alert(`${change.file} changed since these edits were proposed, so they no longer apply cleanly. Nothing was written to it.`)
          continue
        }
        await host.applyFileText(change.file, result)
        applied += keep.length
      }
      finish(applied)
    }
    dlg.showModal()
  })
}
