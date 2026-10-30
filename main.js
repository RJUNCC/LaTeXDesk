const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, net } = require('electron')
const { pathToFileURL } = require('url')
const ai_ = require('./ai')
const research = require('./research')
const { exportSubmission } = require('./export')
const zotero = require('./zotero')
const languagetool = require('./languagetool')
const path = require('path')
const fs = require('fs/promises')
const { spawn } = require('child_process')

const OUT_DIR = '.texdesk'
// some TeX errors loop forever; Overleaf has a similar limit
const COMPILE_TIMEOUT_MS = 3 * 60 * 1000
const TEXT_EXT = /\.(tex|bib|sty|cls|bst|txt|md)$/i
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')

/**
 * The app was called TeXDesk before 0.7, and Electron names the app-data folder after the product. Carry the
 * old folder over (settings, encrypted API keys, Zotero index) the first time LaTeXDesk starts. The old
 * folder is left in place. Only for the default location (tests set their own userData).
 */
function migrateFromTeXDesk() {
  const appData = app.getPath('appData')
  const current = app.getPath('userData')
  const old = path.join(appData, 'TeXDesk')
  if (path.resolve(current) !== path.resolve(appData, 'LaTeXDesk')) return
  const fsSync = require('fs')
  if (fsSync.existsSync(path.join(current, 'settings.json')) || !fsSync.existsSync(path.join(old, 'settings.json'))) return
  try {
    // Chromium caches and locks aren't needed; everything LaTeXDesk itself wrote is
    // ("Local State" is kept: it holds the key Electron encrypts the saved API keys with)
    const skip = new Set(['Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Crashpad', 'blob_storage', 'Service Worker', 'Shared Dictionary', 'DevToolsActivePort', 'SingletonLock', 'lockfile'])
    fsSync.cpSync(old, current, { recursive: true, filter: src => !skip.has(path.basename(src)) })
  } catch (e) {
    console.error('Could not copy settings from TeXDesk:', e)
  }
}
migrateFromTeXDesk()

let win

async function loadSettings() {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE(), 'utf8'))
  } catch {
    return {}
  }
}

// read-merge-writes are queued so concurrent saves (page settings, AI usage) can't undo each other
let settingsWrites = Promise.resolve()
function saveSettings(patch) {
  const write = settingsWrites.then(async () => {
    const settings = { ...(await loadSettings()), ...patch }
    await fs.writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2))
  })
  settingsWrites = write.catch(() => {})
  return write
}

// Resolve a renderer-supplied relative path, refusing anything outside the project.
function resolveInProject(root, rel) {
  root = path.resolve(root)
  const full = path.resolve(root, rel)
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Path outside project: ${rel}`)
  }
  return full
}

async function listFiles(root, dir = root, depth = 0) {
  const out = []
  if (depth > 6) return out
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (entry.isDirectory()) {
      out.push(...(await listFiles(root, full, depth + 1)))
    } else {
      out.push({ path: rel, editable: TEXT_EXT.test(entry.name) })
    }
  }
  return out
}

// processes belonging to the compile in progress, so it can be stopped
const running = new Set()
let cancelled = false

function run(cmd, args, cwd, env) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true })
    running.add(child)
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    // ENOENT: the program isn't installed (e.g. no TeX distribution yet)
    child.on('error', err => (running.delete(child), resolve({ code: -1, output: output + String(err), missing: err.code === 'ENOENT' })))
    child.on('close', code => (running.delete(child), resolve({ code, output })))
  })
}

function cancelCompile() {
  cancelled = true
  for (const child of running) {
    // /T also stops anything TeX started (e.g. MiKTeX's package installer)
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  }
}

// Pick the engine from a "% !TEX program = xelatex" magic comment, like Overleaf/TeXShop.
function detectEngine(source) {
  const m = source.match(/^%\s*!TEX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)/im)
  return m ? m[1].toLowerCase() : 'pdflatex'
}

async function compile(root, mainFile) {
  const mainPath = resolveInProject(root, mainFile)
  const outDir = path.join(root, OUT_DIR)
  await fs.mkdir(outDir, { recursive: true })
  const base = path.basename(mainFile, path.extname(mainFile))
  const cwd = path.dirname(mainPath)
  const engine = detectEngine(await fs.readFile(mainPath, 'utf8'))
  const texArgs = [
    '-interaction=nonstopmode',
    '-file-line-error',
    '-synctex=1',
    `-output-directory=${outDir}`,
    path.basename(mainPath),
  ]

  cancelled = false
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    cancelCompile()
  }, COMPILE_TIMEOUT_MS)
  let transcript = ''
  let result
  let ranBib = false
  for (let pass = 0; pass < 4; pass++) {
    result = await run(engine, texArgs, cwd)
    transcript += result.output
    if (cancelled) break
    const log = await fs.readFile(path.join(outDir, `${base}.log`), 'utf8').catch(() => '')
    // like Overleaf, keep going past errors as long as TeX still produced a PDF
    const pdfExists = await fs.stat(path.join(outDir, `${base}.pdf`)).catch(() => null)
    if (result.code !== 0 && !pdfExists) break

    if (!ranBib) {
      ranBib = true
      const aux = await fs.readFile(path.join(outDir, `${base}.aux`), 'utf8').catch(() => '')
      const bcf = await fs.stat(path.join(outDir, `${base}.bcf`)).catch(() => null)
      if (bcf) {
        transcript += (await run('biber', [`--input-directory=${cwd}`, `--output-directory=${outDir}`, base], outDir)).output
        continue
      }
      if (/\\bibdata/.test(aux)) {
        // bibtex runs inside the output dir, so point it back at the sources for .bib/.bst files
        const env = { ...process.env, BIBINPUTS: cwd + path.delimiter, BSTINPUTS: cwd + path.delimiter }
        transcript += (await run('bibtex', [base], outDir, env)).output
        if (cancelled) break
        continue
      }
    }
    if (!/Rerun to get|Please \(re\)run|Label\(s\) may have changed|rerunfilecheck/i.test(log)) break
  }

  clearTimeout(timer)
  const log = await fs.readFile(path.join(outDir, `${base}.log`), 'utf8').catch(() => transcript)
  const pdfPath = path.join(outDir, `${base}.pdf`)
  const pdf = await fs.readFile(pdfPath).catch(() => null)
  return { ok: result.code === 0, log, pdf, pdfPath, engine, cancelled, timedOut, missingTex: !!result.missing }
}

async function synctex(root, mainFile, args) {
  const outDir = path.join(root, OUT_DIR)
  const base = path.basename(mainFile, path.extname(mainFile))
  const pdf = path.join(outDir, `${base}.pdf`)
  const cwd = path.dirname(resolveInProject(root, mainFile))
  let cmdArgs
  if (args.direction === 'forward') {
    const file = resolveInProject(root, args.file)
    cmdArgs = ['view', '-i', `${args.line}:${args.column || 0}:${file}`, '-o', pdf]
  } else {
    cmdArgs = ['edit', '-o', `${args.page}:${args.x}:${args.y}:${pdf}`]
  }
  const { output } = await run('synctex', cmdArgs, cwd)
  const field = name => {
    const m = output.match(new RegExp(`^${name}:(.*)$`, 'm'))
    return m ? m[1].trim() : null
  }
  if (args.direction === 'forward') {
    if (!field('Page')) return null
    return { page: +field('Page'), x: +field('x'), y: +field('y'), h: +field('h'), v: +field('v'), W: +field('W'), H: +field('H') }
  }
  const input = field('Input')
  if (!input) return null
  const file = path.relative(root, path.resolve(cwd, input)).split(path.sep).join('/')
  return { file, line: +field('Line') }
}

function buildMenu() {
  const send = channel => () => win.webContents.send('menu', channel)
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Project Folder…', accelerator: 'CmdOrCtrl+O', click: send('open-folder') },
        { label: 'New File…', accelerator: 'CmdOrCtrl+N', click: send('new-file') },
        { label: 'New from Template…', accelerator: 'CmdOrCtrl+Shift+N', click: send('templates') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send('settings') },
        { type: 'separator' },
        { label: 'Export for Submission (zip)…', click: send('export') },
        { label: 'Show Project in Explorer', click: send('reveal') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Build',
      submenu: [
        { label: 'Recompile', accelerator: 'CmdOrCtrl+Enter', click: send('compile') },
        { label: 'Set Current File as Main Document', click: send('set-main') },
        { label: 'Jump to Location in PDF', accelerator: 'CmdOrCtrl+Alt+J', click: send('sync-forward') },
        { label: 'Toggle Logs', accelerator: 'CmdOrCtrl+L', click: send('toggle-logs') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Switch Code / Visual Editor', accelerator: 'CmdOrCtrl+Shift+E', click: send('toggle-visual') },
        { label: 'Spell Check', type: 'checkbox', checked: true, click: send('toggle-spell') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Getting Started…', click: send('getting-started') },
        { type: 'separator' },
        { label: 'About LaTeXDesk', click: send('about') },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'LaTeXDesk',
    backgroundColor: '#1e1f22',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, 'dist', 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => {
    // links open in the browser; nothing else (file:, custom schemes) is handed to the OS
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

// the page never sees the AI section (it holds encrypted API keys); it uses the ai:* calls instead
ipcMain.handle('settings:get', async () => {
  const { ai: _ai, ...rest } = await loadSettings()
  return rest
})
ipcMain.handle('settings:set', (_e, patch) => {
  const { ai: _ignored, ...safe } = patch || {}
  return saveSettings(safe)
})

// ---------- AI ----------

/** AI config as the page may see it: everything except the keys, plus which keys exist. */
async function publicAiConfig() {
  const ai = ai_.aiSettings(await loadSettings())
  const { keys, ...rest } = ai
  return { ...rest, hasKey: Object.fromEntries(Object.keys(keys || {}).map(k => [k, true])) }
}

async function updateAi(mutate) {
  const settings = await loadSettings()
  const ai = ai_.aiSettings(settings)
  mutate(ai)
  await saveSettings({ ai })
}

ipcMain.handle('ai:config', () => publicAiConfig())
ipcMain.handle('ai:set-config', async (_e, patch) => {
  await updateAi(ai => {
    if (typeof patch.enabled === 'boolean') ai.enabled = patch.enabled
    if (patch.features) ai.features = { ...ai.features, ...patch.features }
    if (patch.providers) for (const [p, v] of Object.entries(patch.providers)) ai.providers[p] = { ...ai.providers[p], ...v }
  })
  return publicAiConfig()
})
ipcMain.handle('ai:set-key', async (_e, provider, key) => {
  await updateAi(ai => {
    if (key) ai.keys[provider] = ai_.encryptKey(key)
    else delete ai.keys[provider]
  })
  return publicAiConfig()
})
ipcMain.handle('ai:run', async (e, id, req) => {
  const result = await ai_.run(await loadSettings(), id, req, text => e.sender.send('ai:chunk', id, text))
  // running totals per provider for the usage counter
  await updateAi(ai => {
    const u = (ai.usage[result.provider] ??= { requests: 0, input: 0, output: 0, cost: 0 })
    u.requests++
    u.input += result.usage.input || 0
    u.output += result.usage.output || 0
    u.cost += result.cost
  })
  return result
})
ipcMain.handle('ai:cancel', (_e, id) => ai_.cancel(id))
ipcMain.handle('research:cite', (_e, input) => research.cite(input))
ipcMain.handle('research:search', (_e, query) => research.search(query))
// ---------- Zotero (all on localhost) ----------
const ollamaUrl = async () => ai_.aiSettings(await loadSettings()).providers.ollama.url
ipcMain.handle('zotero:status', () => zotero.status())
ipcMain.handle('zotero:search', (_e, query) => zotero.search(query))
ipcMain.handle('zotero:export', (_e, keys) => zotero.exportBib(keys))
ipcMain.handle('zotero:save', (_e, payload) => zotero.save(payload))
ipcMain.handle('zotero:index', async e =>
  zotero.updateIndex({ userData: app.getPath('userData'), ollamaUrl: await ollamaUrl(), onProgress: p => e.sender.send('zotero:index-progress', p) })
)
ipcMain.handle('zotero:retrieve', async (_e, question, k, citekeys) =>
  zotero.retrieve({ userData: app.getPath('userData'), ollamaUrl: await ollamaUrl(), question, k, citekeys })
)
ipcMain.handle('zotero:storage', () => zotero.storage())
// PDFs Zotero hasn't extracted text from: the renderer reads them with pdf.js and hands the text back
ipcMain.handle('zotero:missing-text', () => zotero.missingText({ userData: app.getPath('userData') }))
ipcMain.handle('zotero:pdf-bytes', (_e, key) => zotero.pdfBytes({ userData: app.getPath('userData'), key }))
ipcMain.handle('zotero:save-text', (_e, key, text) => zotero.saveText({ userData: app.getPath('userData'), key, text }))
// embeddings with the local model (used by the project knowledge graph)
ipcMain.handle('ai:embed', async (_e, texts) => zotero.embed(await ollamaUrl(), texts))
// free web evidence for fact checking
ipcMain.handle('web:abstract', (_e, doi) => research.abstractFor(doi))
ipcMain.handle('web:evidence', (_e, claim) => research.webEvidence(claim))
// LanguageTool (local grammar checker)
ipcMain.handle('lt:status', () => languagetool.status(app.getPath('userData')))
ipcMain.handle('lt:install', e => languagetool.install(app.getPath('userData'), p => e.sender.send('lt:install-progress', p)))
ipcMain.handle('lt:check', (_e, annotation, language) => languagetool.check(app.getPath('userData'), annotation, language))
app.on('will-quit', () => languagetool.stop())

// zipPath is only passed by tests; normally the user picks where to save
ipcMain.handle('export:submission', async (_e, root, mainFile, zipPath) => {
  if (!zipPath) {
    const base = path.basename(mainFile, path.extname(mainFile))
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export for submission',
      defaultPath: path.join(path.dirname(path.resolve(root)), `${base}-submission.zip`),
      filters: [{ name: 'Zip archive', extensions: ['zip'] }],
    })
    if (canceled || !filePath) return null
    zipPath = filePath
  }
  return exportSubmission({ root, mainFile, outDir: path.join(root, OUT_DIR), zipPath })
})
ipcMain.handle('ai:models', async (_e, provider) => ai_.listModels(await loadSettings(), provider))
ipcMain.handle('ai:status', async () => ai_.ollamaStatus(await loadSettings()))
ipcMain.handle('ai:pull', async (e, model) =>
  ai_.ollamaPull(await loadSettings(), model, p => e.sender.send('ai:pull-progress', model, p))
)

ipcMain.handle('project:choose', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
  return canceled ? null : filePaths[0]
})

// the open project: listing its files is the first thing the renderer does after opening it
let projectRoot = null
ipcMain.handle('project:list', (_e, root) => ((projectRoot = root), listFiles(root)))

// figures for the visual editor: ldfile://project/<path in project>, image and PDF files of the open project only
// (only allowed before the app is ready; it always is when the app starts normally)
if (!app.isReady()) protocol.registerSchemesAsPrivileged([{ scheme: 'ldfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
function serveProjectFile(request) {
  const rel = decodeURIComponent(new URL(request.url).pathname.slice(1))
  if (!projectRoot || !/\.(png|jpe?g|gif|svg|webp|bmp|pdf)$/i.test(rel)) return new Response('', { status: 404 })
  try {
    return net.fetch(pathToFileURL(resolveInProject(projectRoot, rel)).toString())
  } catch {
    return new Response('', { status: 403 })
  }
}
ipcMain.handle('project:reveal', (_e, root) => shell.openPath(root))

ipcMain.handle('file:read', (_e, root, rel) => fs.readFile(resolveInProject(root, rel), 'utf8'))
// for optional app data (e.g. .texdesk/tasks.json): null instead of an error when it doesn't exist yet
// app data only: refuses anything outside the project's .texdesk folder
ipcMain.handle('file:delete-appdata', async (_e, root, rel) => {
  const full = resolveInProject(root, rel)
  const appDir = path.join(path.resolve(root), OUT_DIR) + path.sep
  if (!full.startsWith(appDir)) throw new Error('Refusing to delete outside .texdesk')
  await fs.rm(full, { force: true })
})
ipcMain.handle('file:read-optional', (_e, root, rel) => fs.readFile(resolveInProject(root, rel), 'utf8').catch(() => null))
ipcMain.handle('file:write', async (_e, root, rel, content) => {
  const full = resolveInProject(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content, 'utf8')
})

// Getting Started: what this computer has (TeX, Java/LanguageTool, Ollama, Zotero)
function which(cmd) {
  return new Promise(resolve => {
    const child = spawn('where', [cmd], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code === 0 ? out.split(/\r?\n/)[0].trim() : null))
  })
}
ipcMain.handle('setup:status', async () => {
  const settings = await loadSettings()
  const [tex, lt, ollama, zot] = await Promise.all([
    which('pdflatex'),
    languagetool.status(app.getPath('userData')).catch(() => ({})),
    ai_.ollamaStatus(settings).catch(() => ({ running: false })),
    zotero.status().catch(() => ({ running: false })),
  ])
  const models = ollama.running ? (await ai_.listModels(settings, 'ollama').catch(() => [])).map(m => m.id) : []
  return {
    tex: { found: !!tex, path: tex },
    java: !!lt.java,
    languagetool: { installed: !!lt.installed, running: !!lt.running },
    ollama: { running: !!ollama.running, models },
    zotero: { running: !!zot.running, betterBibtex: !!zot.betterBibtex },
  }
})
// from package.json, so it's right when running from source too (Electron would report its own name there)
const pkg = require('./package.json')
ipcMain.handle('app:info', () => ({ name: pkg.productName, version: pkg.version }))

ipcMain.handle('compile', (_e, root, mainFile) => compile(root, mainFile))
ipcMain.handle('compile:cancel', () => cancelCompile())
ipcMain.handle('synctex', (_e, root, mainFile, args) => synctex(root, mainFile, args))

app.whenReady().then(() => {
  app.setAppUserModelId('local.texdesk')
  protocol.handle('ldfile', serveProjectFile)
  buildMenu()
  createWindow()
})

app.on('window-all-closed', () => app.quit())
