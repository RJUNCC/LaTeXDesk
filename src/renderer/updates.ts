// Update notices: a small card in the corner when a new version is on GitHub. Nothing is downloaded until the
// user says so; once downloaded, the update installs when LaTeXDesk closes (or straight away on Restart).

export type UpdateState = {
  status: 'idle' | 'checking' | 'available' | 'current' | 'downloading' | 'ready' | 'error' | 'unsupported'
  version?: string
  notes?: string
  percent?: number
  error?: string | null
}
type Bridge = {
  update: {
    check(): Promise<UpdateState>
    download(): Promise<UpdateState>
    install(): Promise<boolean>
    state(): Promise<UpdateState>
    onState(cb: (s: UpdateState) => void): void
  }
  appInfo(): Promise<{ name: string; version: string }>
}
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

const RELEASES = 'https://github.com/RJUNCC/LaTeXDesk/releases'

let card: HTMLElement | null = null
// "Later" hides the notice for that version until the next launch
const dismissed = new Set<string>()
// a check the user asked for (Help → Check for Updates) also reports "you're up to date" and errors
let manual = false

function show(html: string, actions: [string, () => void, boolean?][]) {
  card ??= Object.assign(document.createElement('div'), { id: 'update-card', className: 'update-card' })
  card.innerHTML = `<button class="icon uc-close" title="Close" aria-label="Close">×</button><div class="uc-body">${html}</div><div class="uc-actions"></div>`
  card.querySelector<HTMLButtonElement>('.uc-close')!.onclick = hide
  card.querySelector('.uc-actions')!.replaceChildren(
    ...actions.map(([label, run, primary]) => {
      const b = document.createElement('button')
      b.textContent = label
      if (primary) b.className = 'primary'
      b.onclick = run
      return b
    })
  )
  if (!card.isConnected) document.body.append(card)
}

function hide() {
  card?.remove()
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function render(s: UpdateState) {
  const asked = manual
  if (s.status !== 'checking') manual = false
  switch (s.status) {
    case 'available':
      if (!asked && dismissed.has(s.version!)) return
      return show(
        `<strong>LaTeXDesk ${esc(s.version!)} is available</strong>${s.notes ? `<p class="muted">${esc(s.notes.slice(0, 220))}${s.notes.length > 220 ? '…' : ''}</p>` : ''}`,
        [
          ['Download', () => void bridge.update.download(), true],
          ["What's new", () => window.open(`${RELEASES}/tag/v${s.version}`, '_blank')],
          ['Later', () => (dismissed.add(s.version!), hide())],
        ]
      )
    case 'downloading':
      return show(`<strong>Downloading the update…</strong><div class="uc-bar"><span style="width:${s.percent ?? 0}%"></span></div><span class="muted">${s.percent ?? 0}%</span>`, [])
    case 'ready':
      return show(`<strong>Update ready</strong><p class="muted">LaTeXDesk ${esc(s.version ?? '')} will be installed when you close the app. Your work is saved first.</p>`, [
        ['Restart now', () => void restart(), true],
        ['When I close it', hide],
      ])
    case 'current':
      if (asked) void bridge.appInfo().then(i => show(`<strong>You're up to date</strong><p class="muted">LaTeXDesk ${esc(i.version)} is the newest version.</p>`, [['OK', hide, true]]))
      break
    case 'unsupported':
      if (asked) show(`<strong>Updates need the installed app</strong><p class="muted">This copy runs from the source code. Download installers from the Releases page.</p>`, [['Open Releases', () => window.open(RELEASES, '_blank'), true], ['OK', hide]])
      break
    case 'error':
      // automatic checks stay quiet when offline; asked-for checks say what went wrong
      if (asked) show(`<strong>Couldn't check for updates</strong><p class="muted">${esc(s.error ?? '')}</p>`, [['Open Releases', () => window.open(RELEASES, '_blank')], ['OK', hide, true]])
      break
  }
}

let beforeRestart: () => Promise<void> = async () => {}

async function restart() {
  await beforeRestart()
  await bridge.update.install()
}

/** `save` runs before the app restarts to install an update. */
export function initUpdates(save: () => Promise<void>) {
  beforeRestart = save
  bridge.update.onState(render)
  // a check may have finished before the page was listening
  void bridge.update.state().then(s => s.status === 'available' || s.status === 'ready' ? render(s) : undefined)
}

/** Help → Check for Updates. */
export async function checkForUpdates() {
  manual = true
  show('<strong>Checking for updates…</strong>', [])
  const s = await bridge.update.check()
  // the state event normally renders the result; this covers checks that end without one
  if (manual) render(s)
}
