// Getting Started (Help menu, and shown on first launch): choose how to write (Visual or Code), and see what
// this computer still needs. TeX is required to make PDFs; grammar checking, local AI and Zotero are optional.
import { ai } from './ai-client'
import { RECOMMENDED } from './ai-settings'
import { lt } from './grammar'

type SetupStatus = {
  tex: { found: boolean; path: string | null }
  java: boolean
  languagetool: { installed: boolean; running: boolean }
  ollama: { running: boolean; models: string[] }
  zotero: { running: boolean; betterBibtex: boolean }
}
type Bridge = { setupStatus(): Promise<SetupStatus>; appInfo(): Promise<{ name: string; version: string }> }
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

/** Where the source code lives (the AGPL requires offering it to everyone who gets the app). */
const SOURCE_URL = 'https://github.com/RJUNCC/LaTeXDesk'

let dialog: HTMLDialogElement | null = null

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

/**
 * Open the dialog. `mode` is the current editor mode and `setMode` switches it; `firstRun` adds the welcome line.
 */
export function openGettingStarted(opts: { mode: 'code' | 'visual'; setMode: (m: 'code' | 'visual') => void; firstRun?: boolean }) {
  dialog?.remove()
  dialog = document.createElement('dialog')
  dialog.id = 'getting-started'
  dialog.className = 'wide gs'
  dialog.innerHTML = `
    <form method="dialog">
      <h3>${opts.firstRun ? 'Welcome to LaTeXDesk' : 'Getting Started'}</h3>
      ${opts.firstRun ? '<p class="muted">A desktop editor for papers, reports and maths. Everything runs on your computer.</p>' : ''}
      <h4>How do you want to write?</h4>
      <div class="gs-modes">
        <button type="button" class="gs-mode" data-mode="visual">
          <strong>Visual</strong>
          <span>Like a word processor: headings, bold, lists and equations look the way they will in the PDF. Use the toolbar buttons. No LaTeX needed.</span>
        </button>
        <button type="button" class="gs-mode" data-mode="code">
          <strong>Code</strong>
          <span>The LaTeX source, with autocomplete and previews. For people who know LaTeX.</span>
        </button>
      </div>
      <p class="muted gs-note">You can switch any time with the Code | Visual buttons above the editor (Ctrl+Shift+E). The file is the same either way.</p>
      <h4>Your computer <button type="button" class="gs-recheck">Re-check</button></h4>
      <ul class="gs-checks"><li class="muted">Checking…</li></ul>
      <details class="gs-keys"><summary>Keyboard shortcuts</summary>
        <table>
          <tr><td>Ctrl+S</td><td>Save (and compile if Auto is on)</td></tr>
          <tr><td>Ctrl+Enter</td><td>Compile</td></tr>
          <tr><td>Ctrl+B / Ctrl+I</td><td>Bold / italic</td></tr>
          <tr><td>Ctrl+Shift+E</td><td>Switch Code / Visual</td></tr>
          <tr><td>Ctrl+N</td><td>New file</td></tr>
          <tr><td>Ctrl+,</td><td>Settings</td></tr>
          <tr><td>Ctrl+Alt+J</td><td>Jump from the source to the PDF</td></tr>
        </table>
      </details>
      <menu><button value="close" class="primary">Done</button></menu>
    </form>`
  document.body.append(dialog)
  const q = <T extends HTMLElement>(s: string) => dialog!.querySelector<T>(s)!
  const showMode = (m: string) => dialog!.querySelectorAll<HTMLButtonElement>('.gs-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === m))
  showMode(opts.mode)
  dialog.querySelectorAll<HTMLButtonElement>('.gs-mode').forEach(b => {
    b.onclick = () => {
      opts.setMode(b.dataset.mode as 'code' | 'visual')
      showMode(b.dataset.mode!)
    }
  })
  q('.gs-recheck').onclick = () => void renderChecks()
  dialog.addEventListener('close', () => dialog?.remove())
  dialog.showModal()
  void renderChecks()
}

type Row = { ok: boolean; optional: boolean; title: string; detail: string; action?: { label: string; run: () => Promise<unknown> } }

async function renderChecks() {
  const list = dialog?.querySelector<HTMLElement>('.gs-checks')
  if (!list) return
  list.innerHTML = '<li class="muted">Checking…</li>'
  const s = await bridge.setupStatus()
  const wanted = [...new Set(Object.values(RECOMMENDED))]
  const missingModels = wanted.filter(m => !s.ollama.models.includes(m))
  const rows: Row[] = [
    {
      ok: s.tex.found,
      optional: false,
      title: 'TeX (needed to make PDFs)',
      detail: s.tex.found
        ? `Found ${esc(s.tex.path ?? '')}`
        : 'Install <a href="https://miktex.org/download" target="_blank">MiKTeX</a> (free), choosing “install missing packages on the fly: Yes”. Then restart LaTeXDesk.',
    },
    {
      ok: s.java && s.languagetool.installed,
      optional: true,
      title: 'Grammar checking',
      detail: !s.java
        ? 'Needs Java: install <a href="https://adoptium.net/" target="_blank">Temurin</a> (free), then come back here.'
        : s.languagetool.installed
          ? 'LanguageTool is installed and runs on your computer.'
          : 'Java is ready. LanguageTool (about 250 MB) checks grammar and style on your computer.',
      action: s.java && !s.languagetool.installed ? { label: 'Install LanguageTool', run: () => lt.install() } : undefined,
    },
    {
      ok: s.ollama.running && missingModels.length === 0,
      optional: true,
      title: 'Local AI (autocomplete, review, proofs)',
      detail: !s.ollama.running
        ? 'Install <a href="https://ollama.com/download" target="_blank">Ollama</a> (free) to run AI on your computer, or add a Claude API key in Settings. A graphics card with 8 GB+ of memory helps.'
        : missingModels.length
          ? `Ollama is running. Recommended models not downloaded yet: ${missingModels.map(esc).join(', ')} (about 20 GB in total).`
          : 'Ollama is running with the recommended models.',
      action: s.ollama.running && missingModels.length ? { label: 'Download models', run: async () => { for (const m of missingModels) await ai.pull(m) } } : undefined,
    },
    {
      ok: s.zotero.running && s.zotero.betterBibtex,
      optional: true,
      title: 'Zotero (your reference library)',
      detail:
        s.zotero.running && s.zotero.betterBibtex
          ? 'Connected: cite from your library, and fact-check against your PDFs.'
          : s.zotero.running
            ? 'Zotero is running. Add the <a href="https://retorque.re/zotero-better-bibtex/installation/" target="_blank">Better BibTeX</a> plugin to cite from it.'
            : 'Optional: <a href="https://www.zotero.org/download/" target="_blank">Zotero</a> with the Better BibTeX plugin, then keep it open while you write.',
    },
  ]
  list.replaceChildren(
    ...rows.map(r => {
      const li = document.createElement('li')
      li.className = `gs-check ${r.ok ? 'ok' : r.optional ? 'optional' : 'needed'}`
      li.innerHTML = `<span class="gs-dot"></span><div><strong>${r.title}</strong>${r.optional ? ' <span class="muted">(optional)</span>' : ''}<div class="gs-detail">${r.detail}</div></div>`
      if (r.action) {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = r.action.label
        b.onclick = async () => {
          b.disabled = true
          b.textContent = 'Working… (this can take a while)'
          try {
            await r.action!.run()
          } catch (e) {
            b.textContent = `⚠ ${(e as Error).message}`
            return
          }
          void renderChecks()
        }
        li.append(b)
      }
      return li
    })
  )
}

export async function showAbout() {
  const info = await bridge.appInfo()
  const d = document.createElement('dialog')
  d.innerHTML = `<form method="dialog">
    <h3>${esc(info.name)} ${esc(info.version)}</h3>
    <p>A desktop LaTeX editor with a visual mode, local AI and Zotero integration.</p>
    <p>Source code, downloads and updates: <a href="${SOURCE_URL}" target="_blank">${SOURCE_URL.replace('https://', '')}</a></p>
    <p class="muted">Built on Overleaf’s open-source editor components. Free software under the GNU AGPL-3.0: you may use, share and change it, and anyone you give it to is entitled to its source code. See LICENSE and THIRD_PARTY_NOTICES.md.</p>
    <menu><button value="close" class="primary">OK</button></menu></form>`
  d.addEventListener('close', () => d.remove())
  document.body.append(d)
  d.showModal()
}
