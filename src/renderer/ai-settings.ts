// Settings: general (TeX engine, your name, updates), then AI: providers, keys, a model per feature, local model
// downloads, usage counter.
import { ai, AiConfig, AiFeature, AiProvider, aiConfig, runAi, setConfigCache } from './ai-client'
import { installBuiltInTex, texStatus } from './tex-setup'
import { checkForUpdates } from './updates'

type GeneralSettings = { texEngine?: 'auto' | 'system' | 'tectonic'; authorName?: string; autoUpdate?: boolean }
type Bridge = { getSettings(): Promise<GeneralSettings>; setSettings(p: GeneralSettings): Promise<void>; appInfo(): Promise<{ user: string }> }
const bridge = (window as unknown as { texdesk: Bridge }).texdesk

const FEATURES: { id: AiFeature; label: string; hint: string; needs?: string }[] = [
  { id: 'autocomplete', label: 'Autocomplete', hint: 'Grey inline suggestions while you type (Tab accepts). Needs a fast model.', needs: 'insert' },
  { id: 'review', label: 'Review, chat & error help', hint: 'Explain & fix errors, proofreading, the AI tab.' },
  { id: 'tasks', label: 'Tasks', hint: 'Runs to-do items as proposed edits you review.' },
  { id: 'analysis', label: 'Writing analysis', hint: 'Flow, claims, fact check, argument and bias (Review tab).' },
  { id: 'proof', label: 'Proofs', hint: 'Builds and checks proofs step by step (Proof tab). Reasons before answering, so it is slower.' },
  { id: 'vision', label: 'Screenshot → LaTeX', hint: 'Turns images of equations/tables into LaTeX.', needs: 'vision' },
]

/** Local defaults, used when a feature has no model yet and the model is installed. */
export const RECOMMENDED: Record<AiFeature, string> = {
  autocomplete: 'qwen2.5-coder:7b',
  review: 'qwen3:14b',
  chat: 'qwen3:14b',
  tasks: 'qwen3:14b',
  vision: 'qwen2.5vl:7b',
  analysis: 'qwen3:14b',
  proof: 'qwen3:14b',
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  ollama: 'Local (Ollama)',
  anthropic: 'Claude API',
  openai: 'OpenAI-compatible',
}

/** Point unconfigured features at installed local models, so AI works out of the box at no cost. */
export async function applyRecommendedDefaults() {
  const config = await aiConfig(true)
  const missing = FEATURES.filter(f => !config.features[f.id]?.model)
  if (!missing.length) return config
  const status = await ai.status()
  if (!status.running) return config
  const installed = new Set((await ai.models('ollama').catch(() => [])).map(m => m.id))
  const features: AiConfig['features'] = {}
  for (const f of missing) if (installed.has(RECOMMENDED[f.id])) features[f.id] = { provider: 'ollama', model: RECOMMENDED[f.id] }
  if (!Object.keys(features).length) return config
  const updated = await ai.setConfig({ features })
  setConfigCache(updated)
  return updated
}

let dialog: HTMLDialogElement | null = null

// registered once: download progress goes to whichever settings dialog exists
ai.onPullProgress((model, p) => {
  const el = dialog?.querySelector('.as-pull-status')
  if (el) el.textContent = `${model}: ${p.status}${p.fraction != null ? ` ${Math.round(p.fraction * 100)}%` : ''}`
})

function buildDialog() {
  const dlg = document.createElement('dialog')
  dlg.id = 'ai-settings'
  dlg.className = 'wide ai-settings'
  dlg.innerHTML = `
    <h3>Settings</h3>
    <section class="as-section as-general">
      <h4>General</h4>
      <div class="as-row"><label>TeX engine</label><select class="as-engine">
        <option value="auto">Automatic: installed TeX if there is one, else built-in</option>
        <option value="system">Installed TeX (MiKTeX or TeX Live)</option>
        <option value="tectonic">Built-in (Tectonic)</option>
      </select><button type="button" class="as-tex-install" hidden>Set up built-in TeX</button></div>
      <div class="as-tex-status muted"></div>
      <div class="as-row"><label>Your name</label><input class="as-author" placeholder="shown on your comments and suggested changes"></div>
      <div class="as-row"><label class="check"><input type="checkbox" class="as-autoupdate"> Check for updates automatically</label><button type="button" class="as-check-updates">Check now</button></div>
    </section>

    <h3>AI</h3>
    <label class="check as-master"><input type="checkbox" class="as-enabled"> Use AI features</label>
    <p class="muted">Local models run on your own GPU through Ollama: free and private. Cloud providers are optional and cost tokens per request.</p>

    <section class="as-section">
      <h4>Models per feature</h4>
      <table class="as-features"></table>
    </section>

    <section class="as-section">
      <h4>Local (Ollama) <span class="as-ollama-status muted"></span></h4>
      <div class="as-row"><label>Server</label><input class="as-ollama-url"></div>
      <div class="as-installed"></div>
      <div class="as-row"><button type="button" class="as-pull">Download recommended models</button><span class="as-pull-status muted"></span></div>
    </section>

    <section class="as-section">
      <h4>Claude API <span class="as-claude-status muted"></span></h4>
      <div class="as-row"><label>API key</label><input type="password" class="as-claude-key" placeholder="sk-ant-…  (stored encrypted on this computer)">
        <button type="button" class="as-claude-save">Save</button><button type="button" class="as-claude-remove">Remove</button></div>
      <div class="as-key-error as-claude-error" hidden></div>
    </section>

    <section class="as-section">
      <h4>OpenAI-compatible server <span class="muted">(LM Studio, OpenRouter, …)</span></h4>
      <div class="as-row"><label>Base URL</label><input class="as-openai-url"></div>
      <div class="as-row"><label>API key</label><input type="password" class="as-openai-key" placeholder="optional">
        <button type="button" class="as-openai-save">Save</button></div>
      <div class="as-key-error as-openai-error" hidden></div>
    </section>

    <section class="as-section">
      <h4>Usage</h4>
      <div class="as-usage muted"></div>
    </section>
    <menu><button type="button" class="primary as-close">Done</button></menu>`
  document.body.appendChild(dlg)
  return dlg
}

export async function openAiSettings(onChange: () => void = () => {}) {
  dialog ??= buildDialog()
  const dlg = dialog
  const q = <T extends Element>(s: string) => dlg.querySelector<T>(s)!
  let config = await aiConfig(true)
  const modelCache: Partial<Record<AiProvider, { id: string; capabilities?: string[] }[] | string>> = {}

  const save = async (patch: Parameters<typeof ai.setConfig>[0]) => {
    config = await ai.setConfig(patch)
    setConfigCache(config)
    onChange()
  }

  async function models(provider: AiProvider) {
    if (!modelCache[provider]) {
      try {
        modelCache[provider] = await ai.models(provider)
      } catch (e) {
        modelCache[provider] = String((e as Error).message || e)
      }
    }
    return modelCache[provider]!
  }

  async function renderFeatures() {
    const table = q<HTMLTableElement>('.as-features')
    table.replaceChildren()
    for (const f of FEATURES) {
      const row = table.insertRow()
      const choice = config.features[f.id] ?? { provider: 'ollama' as AiProvider, model: '' }
      const name = row.insertCell()
      name.innerHTML = `<strong></strong><div class="muted"></div>`
      name.querySelector('strong')!.textContent = f.label
      name.querySelector('div')!.textContent = f.hint

      const providerSel = document.createElement('select')
      for (const p of Object.keys(PROVIDER_LABEL) as AiProvider[]) providerSel.add(new Option(PROVIDER_LABEL[p], p, false, p === choice.provider))
      row.insertCell().appendChild(providerSel)

      const modelSel = document.createElement('select')
      const modelCell = row.insertCell()
      modelCell.appendChild(modelSel)
      const fill = async () => {
        modelSel.replaceChildren(new Option('loading…', ''))
        const list = await models(providerSel.value as AiProvider)
        modelSel.replaceChildren(new Option('— off —', ''))
        if (typeof list === 'string') {
          modelSel.add(new Option(`unavailable: ${list.slice(0, 60)}`, ''))
          modelSel.disabled = true
          return
        }
        modelSel.disabled = false
        // embedding-only models (e.g. nomic-embed-text, used by Ask my library) can't chat or complete
        for (const m of list.filter(m => !(m.capabilities?.includes('embedding') && !m.capabilities.includes('completion')))) {
          // flag models that lack what the feature needs (e.g. no image input for Screenshot → LaTeX)
          const lacks = f.needs && m.capabilities && !m.capabilities.includes(f.needs)
          const label = lacks ? `${m.id}  (no ${f.needs === 'insert' ? 'fill-in-middle; slower' : f.needs})` : m.id
          modelSel.add(new Option(label, m.id, false, m.id === choice.model))
        }
        if (choice.model && ![...modelSel.options].some(o => o.value === choice.model)) {
          modelSel.add(new Option(`${choice.model} (not found)`, choice.model, false, true))
        }
      }
      providerSel.onchange = async () => {
        await fill()
        await save({ features: { [f.id]: { provider: providerSel.value as AiProvider, model: modelSel.value } } })
      }
      modelSel.onchange = () => save({ features: { [f.id]: { provider: providerSel.value as AiProvider, model: modelSel.value } } })
      void fill()

      const test = document.createElement('button')
      test.type = 'button'
      test.textContent = 'Test'
      const out = document.createElement('span')
      out.className = 'as-test muted'
      test.onclick = async () => {
        out.textContent = 'running…'
        const started = performance.now()
        try {
          const r = await runAi(
            f.id === 'autocomplete'
              ? { feature: f.id, fim: { prefix: 'The quick brown fox jumps over the', suffix: '' }, maxTokens: 8 }
              : { feature: f.id, messages: [{ role: 'user', content: 'Reply with the single word OK.' }], maxTokens: 10 }
          ).result
          out.textContent = `✓ ${((performance.now() - started) / 1000).toFixed(1)}s: "${r.text.trim().slice(0, 30)}"`
        } catch (e) {
          out.textContent = `✗ ${(e as Error).message}`
        }
      }
      const testCell = row.insertCell()
      testCell.append(test, out)
    }
  }

  async function renderOllama() {
    const status = await ai.status()
    q('.as-ollama-status').textContent = status.running ? `running (v${status.version})` : 'not running: start Ollama, or install it from ollama.com'
    q<HTMLInputElement>('.as-ollama-url').value = config.providers.ollama.url
    const list = status.running ? await models('ollama') : []
    q('.as-installed').replaceChildren(
      ...(typeof list === 'string' ? [] : list).map(m => {
        const d = document.createElement('div')
        d.className = 'as-model'
        d.textContent = `${m.id}  ${m.capabilities?.filter(c => c !== 'completion').map(c => `[${c}]`).join(' ') ?? ''}`
        return d
      })
    )
    q<HTMLButtonElement>('.as-pull').disabled = !status.running
  }

  function renderUsage() {
    const rows = Object.entries(config.usage ?? {}).map(
      ([p, u]) =>
        `${PROVIDER_LABEL[p as AiProvider] ?? p}: ${u!.requests} requests, ${u!.input.toLocaleString()} in / ${u!.output.toLocaleString()} out tokens` +
        (p === 'ollama' ? ' (free)' : `, ≈ $${u!.cost.toFixed(4)}`)
    )
    q('.as-usage').textContent = rows.length ? rows.join(' · ') : 'No AI requests yet.'
  }

  // ----- general -----
  const general = await bridge.getSettings()
  const engine = q<HTMLSelectElement>('.as-engine')
  engine.value = general.texEngine ?? 'auto'
  async function renderTex() {
    const t = await texStatus()
    q('.as-tex-status').textContent =
      (t.engine === 'tectonic' ? 'Compiling with the built-in engine.' : t.engine === 'system' ? `Compiling with ${t.system}.` : 'No TeX engine available for this choice yet.') +
      (t.tectonic ? '' : ` The built-in engine isn't set up (about ${Math.round(t.downloadBytes / 1e6)} MB).`) +
      (t.engine === 'tectonic' && !t.biber ? ' Documents using biblatex need biber, which it doesn’t include.' : '')
    q<HTMLButtonElement>('.as-tex-install').hidden = t.tectonic
  }
  engine.onchange = async () => {
    await bridge.setSettings({ texEngine: engine.value as GeneralSettings['texEngine'] })
    await renderTex()
  }
  q<HTMLButtonElement>('.as-tex-install').onclick = async ev => {
    const b = ev.target as HTMLButtonElement
    b.disabled = true
    try {
      await installBuiltInTex(text => (q('.as-tex-status').textContent = text))
    } catch (e) {
      q('.as-tex-status').textContent = `⚠ ${(e as Error).message}`
      b.disabled = false
      return
    }
    b.disabled = false
    await renderTex()
  }
  const author = q<HTMLInputElement>('.as-author')
  author.value = general.authorName ?? (await bridge.appInfo()).user ?? ''
  author.onchange = () => bridge.setSettings({ authorName: author.value.trim() })
  const autoUpdate = q<HTMLInputElement>('.as-autoupdate')
  autoUpdate.checked = general.autoUpdate !== false
  autoUpdate.onchange = () => bridge.setSettings({ autoUpdate: autoUpdate.checked })
  q<HTMLButtonElement>('.as-check-updates').onclick = () => void checkForUpdates()
  void renderTex()

  // ----- wiring -----
  const enabled = q<HTMLInputElement>('.as-enabled')
  enabled.checked = config.enabled
  enabled.onchange = () => save({ enabled: enabled.checked })
  q<HTMLInputElement>('.as-ollama-url').onchange = async ev => {
    await save({ providers: { ollama: { url: (ev.target as HTMLInputElement).value.trim() } } })
    delete modelCache.ollama
    await renderOllama()
    await renderFeatures()
  }
  q<HTMLInputElement>('.as-openai-url').value = config.providers.openai.url
  q<HTMLInputElement>('.as-openai-url').onchange = async ev => {
    await save({ providers: { openai: { url: (ev.target as HTMLInputElement).value.trim() } } })
    delete modelCache.openai
    await renderFeatures()
  }
  const claudeStatus = () => (q('.as-claude-status').textContent = config.hasKey.anthropic ? '(key saved)' : '(no key)')
  claudeStatus()
  // saving can fail (e.g. Linux with no keyring to protect the key): say why, next to the field
  const saveKey = async (provider: 'anthropic' | 'openai', key: string) => {
    const error = q<HTMLElement>(provider === 'anthropic' ? '.as-claude-error' : '.as-openai-error')
    error.hidden = true
    try {
      return await ai.setKey(provider, key)
    } catch (e) {
      error.textContent = `⚠ ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`
      error.hidden = false
      return null
    }
  }
  q<HTMLButtonElement>('.as-claude-save').onclick = async () => {
    const input = q<HTMLInputElement>('.as-claude-key')
    if (!input.value.trim()) return
    const saved = await saveKey('anthropic', input.value.trim())
    if (!saved) return
    config = saved
    setConfigCache(config)
    input.value = ''
    delete modelCache.anthropic
    claudeStatus()
    await renderFeatures()
  }
  q<HTMLButtonElement>('.as-claude-remove').onclick = async () => {
    config = await ai.setKey('anthropic', '')
    setConfigCache(config)
    delete modelCache.anthropic
    claudeStatus()
    await renderFeatures()
  }
  q<HTMLButtonElement>('.as-openai-save').onclick = async () => {
    const input = q<HTMLInputElement>('.as-openai-key')
    const saved = await saveKey('openai', input.value.trim())
    if (!saved) return
    config = saved
    setConfigCache(config)
    input.value = ''
    delete modelCache.openai
  }
  q<HTMLButtonElement>('.as-pull').onclick = async () => {
    const statusEl = q('.as-pull-status')
    const wanted = [...new Set(Object.values(RECOMMENDED))]
    for (const model of wanted) {
      statusEl.textContent = `${model}: starting…`
      try {
        await ai.pull(model)
      } catch (e) {
        statusEl.textContent = `${model}: ${(e as Error).message}`
        return
      }
    }
    statusEl.textContent = 'All recommended models are installed.'
    delete modelCache.ollama
    config = await applyRecommendedDefaults()
    await renderOllama()
    await renderFeatures()
  }
  q<HTMLButtonElement>('.as-close').onclick = () => dlg.close()

  renderUsage()
  dlg.showModal()
  await renderOllama()
  await renderFeatures()
}
