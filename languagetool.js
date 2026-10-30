// LanguageTool (main process): a local, open-source grammar/style checker running on the user's Java.
// Installed once into the app data folder (or reused where already installed), started on first use, stopped on quit.
const { spawn } = require('child_process')
const fs = require('fs/promises')
const path = require('path')

const PORT = 8081
const BASE = `http://localhost:${PORT}`
const DOWNLOAD = 'https://languagetool.org/download/LanguageTool-stable.zip'
// spelling is Hunspell's job; these rules are noise on text extracted from LaTeX
const DISABLED = ['MORFOLOGIK_RULE_EN_US', 'MORFOLOGIK_RULE_EN_GB', 'WHITESPACE_RULE', 'COMMA_PARENTHESIS_WHITESPACE', 'DOUBLE_PUNCTUATION', 'UPPERCASE_SENTENCE_START', 'EN_QUOTES', 'DASH_RULE', 'PUNCTUATION_PARAGRAPH_END', 'CONSECUTIVE_SPACES']

let server = null
let starting = null

// Where LanguageTool lives: an existing install in one of these folders is reused where it is (a developer
// machine keeps big tools on a separate drive); otherwise it goes in the app's own data folder, never onto
// some other drive of the user's.
const EXISTING_INSTALLS = ['Y:\\LanguageTool']

async function installRoot(userData, existing = EXISTING_INSTALLS) {
  for (const dir of existing) if (await findServerJar(dir)) return dir
  return path.join(userData, 'LanguageTool')
}

async function findServerJar(root) {
  try {
    for (const d of await fs.readdir(root)) {
      const jar = path.join(root, d, 'languagetool-server.jar')
      if (await fs.stat(jar).then(() => true, () => false)) return jar
    }
  } catch {}
  return null
}

const alive = () => fetch(`${BASE}/v2/languages`, { signal: AbortSignal.timeout(1500) }).then(r => r.ok, () => false)

async function status(userData) {
  const jar = await findServerJar(await installRoot(userData))
  const java = await new Promise(resolve => {
    const p = spawn('java', ['-version'], { windowsHide: true })
    p.on('error', () => resolve(false))
    p.on('close', code => resolve(code === 0))
  })
  return { installed: !!jar, java, running: await alive(), jar }
}

/** Download (~250 MB) and unpack LanguageTool; progress is reported as a fraction. */
async function install(userData, onProgress = () => {}) {
  const root = await installRoot(userData)
  await fs.mkdir(root, { recursive: true })
  const zip = path.join(root, 'LanguageTool-stable.zip')
  const res = await fetch(DOWNLOAD)
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
  const total = Number(res.headers.get('content-length')) || 0
  const out = await fs.open(zip, 'w')
  let got = 0
  for await (const chunk of res.body) {
    await out.write(chunk)
    got += chunk.length
    if (total) onProgress({ stage: 'download', fraction: got / total })
  }
  await out.close()
  onProgress({ stage: 'unpack', fraction: null })
  // Windows' bsdtar unpacks zip files
  await new Promise((resolve, reject) => {
    const p = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip], { cwd: root, windowsHide: true })
    p.on('error', reject)
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`unpacking failed (${code})`))))
  })
  await fs.rm(zip, { force: true })
  return status(userData)
}

/** Start the local server if needed (one instance, shared by every check). */
async function ensureRunning(userData) {
  if (await alive()) return
  if (starting) return starting
  starting = (async () => {
    const jar = await findServerJar(await installRoot(userData))
    if (!jar) throw new Error('LanguageTool is not installed')
    server = spawn('java', ['-Xmx1g', '-cp', jar, 'org.languagetool.server.HTTPServer', '--port', String(PORT)], {
      cwd: path.dirname(jar),
      windowsHide: true,
      stdio: 'ignore',
    })
    server.on('exit', () => (server = null))
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 250))
      if (await alive()) return
    }
    throw new Error('LanguageTool did not start (is Java 17+ installed?)')
  })().finally(() => (starting = null))
  return starting
}

/**
 * Check annotated text (LanguageTool's `data` format: [{text} | {markup, interpretAs}]).
 * Returns matches with offsets into the annotation's text+interpretAs stream.
 */
async function check(userData, annotation, language = 'en-US') {
  await ensureRunning(userData)
  const body = new URLSearchParams({
    language,
    data: JSON.stringify({ annotation }),
    disabledRules: DISABLED.join(','),
    level: 'picky',
  })
  const res = await fetch(`${BASE}/v2/check`, { method: 'POST', body, signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`LanguageTool answered HTTP ${res.status}`)
  const data = await res.json()
  return data.matches.map(m => ({
    offset: m.offset,
    length: m.length,
    message: m.message,
    shortMessage: m.shortMessage,
    replacements: m.replacements.slice(0, 5).map(r => r.value),
    rule: m.rule.id,
    category: m.rule.category?.id ?? '',
    issueType: m.rule.issueType ?? '',
  }))
}

function stop() {
  if (server) server.kill()
  server = null
}

module.exports = { status, install, ensureRunning, check, stop, installRoot }
