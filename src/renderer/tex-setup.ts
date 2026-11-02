// Setting up a TeX engine. When no TeX is installed, LaTeXDesk offers its built-in engine (Tectonic, about
// 20 MB, downloaded once), or MiKTeX for people who want a full distribution.

export type TexStatus = {
  preference: 'auto' | 'system' | 'tectonic'
  engine: 'system' | 'tectonic' | null
  system: string | null
  tectonic: boolean
  biber: boolean
  tectonicVersion: string
  downloadBytes: number
}
type Progress = { phase: 'download' | 'unpack' | 'done'; received?: number; total?: number; fraction: number }
type Bridge = { tex: { status(): Promise<TexStatus>; install(): Promise<TexStatus>; onInstallProgress(cb: (p: Progress) => void): void } }
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

export const texStatus = () => bridge.tex.status()

const progressListeners = new Set<(p: Progress) => void>()
bridge.tex.onInstallProgress(p => progressListeners.forEach(cb => cb(p)))

const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`

/** Download and set up the built-in engine, reporting progress as text. */
export async function installBuiltInTex(onProgress: (text: string, fraction: number) => void = () => {}) {
  const listen = (p: Progress) =>
    onProgress(p.phase === 'download' ? `Downloading… ${mb(p.received ?? 0)} of ${mb(p.total ?? 0)}` : p.phase === 'unpack' ? 'Setting up…' : 'Ready', p.fraction)
  progressListeners.add(listen)
  try {
    return await bridge.tex.install()
  } finally {
    progressListeners.delete(listen)
  }
}

let open: HTMLDialogElement | null = null

/**
 * Shown when a compile finds no TeX: set up the built-in engine (then `onReady` compiles again), or get MiKTeX.
 */
export async function offerTexSetup(onReady: () => void) {
  if (open) return
  const status = await texStatus()
  const dlg = document.createElement('dialog')
  open = dlg
  dlg.id = 'tex-setup'
  dlg.className = 'tex-setup'
  dlg.innerHTML = `
    <form method="dialog">
      <h3>Set up PDF making</h3>
      <p>To turn your document into a PDF, LaTeXDesk needs a TeX engine. This computer doesn't have one yet.</p>
      <div class="ts-option recommended">
        <div><strong>Built-in engine</strong> <span class="muted">(recommended)</span>
          <div class="muted">About ${mb(status.downloadBytes)}, downloaded once. The first time a document uses a LaTeX package, it's downloaded too, so the first compile needs the internet and takes a little longer.</div></div>
        <button type="button" class="primary ts-install">Set up</button>
      </div>
      <div class="ts-progress" hidden><div class="ts-bar"><span></span></div><span class="ts-text muted"></span></div>
      <div class="ts-option">
        <div><strong>MiKTeX</strong>
          <div class="muted">A full TeX distribution (about 1 GB once packages are added), if you need biblatex/biber or work offline a lot. Choose “install missing packages on the fly: Yes”, then restart LaTeXDesk.</div></div>
        <a class="button" href="https://miktex.org/download" target="_blank">Get MiKTeX</a>
      </div>
      <menu><button value="close">Not now</button></menu>
    </form>`
  document.body.append(dlg)
  dlg.addEventListener('close', () => ((open = null), dlg.remove()))
  const install = dlg.querySelector<HTMLButtonElement>('.ts-install')!
  install.onclick = async () => {
    install.disabled = true
    const progress = dlg.querySelector<HTMLElement>('.ts-progress')!
    progress.hidden = false
    const bar = dlg.querySelector<HTMLElement>('.ts-bar span')!
    const text = dlg.querySelector<HTMLElement>('.ts-text')!
    try {
      await installBuiltInTex((t, f) => ((text.textContent = t), (bar.style.width = `${Math.round(f * 100)}%`)))
      dlg.close()
      onReady()
    } catch (e) {
      text.textContent = `⚠ ${(e as Error).message}`
      install.disabled = false
      install.textContent = 'Try again'
    }
  }
  dlg.showModal()
}
