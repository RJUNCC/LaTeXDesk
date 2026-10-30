// The tabbed right-hand pane: PDF | AI | Review | Proof | Tasks | References | Library | Research | History.

export type PanelName = 'pdf' | 'ai' | 'review' | 'proof' | 'tasks' | 'references' | 'library' | 'research' | 'history'

const tabs = () => [...document.querySelectorAll<HTMLButtonElement>('#side-tabs button[data-panel]')]
const panels = () => [...document.querySelectorAll<HTMLElement>('.side-panel')]

const onShow = new Map<PanelName, () => void>()

export function panelEl(name: PanelName) {
  return document.querySelector<HTMLElement>(`.side-panel[data-panel="${name}"]`)!
}

export function currentPanel(): PanelName {
  return (tabs().find(t => t.classList.contains('active'))?.dataset.panel ?? 'pdf') as PanelName
}

export function showPanel(name: PanelName) {
  tabs().forEach(t => t.classList.toggle('active', t.dataset.panel === name))
  panels().forEach(p => (p.hidden = p.dataset.panel !== name))
  try {
    localStorage.setItem('texdesk.panel', name)
  } catch {}
  onShow.get(name)?.()
}

/** Run `fn` whenever a panel becomes visible (to refresh its contents lazily). */
export function whenShown(name: PanelName, fn: () => void) {
  onShow.set(name, fn)
}

export function setBadge(name: 'ai' | 'tasks' | 'refs' | 'review', count: number | string) {
  const el = document.getElementById(`${name}-badge`)
  if (el) el.textContent = count ? String(count) : ''
}

export function initPanels() {
  for (const t of tabs()) t.onclick = () => showPanel(t.dataset.panel as PanelName)
  let saved: string | null = null
  try {
    saved = localStorage.getItem('texdesk.panel')
  } catch {}
  if (saved && tabs().some(t => t.dataset.panel === saved)) showPanel(saved as PanelName)
}
