// Which TeX engine compiles documents: an installed distribution (MiKTeX, TeX Live) or LaTeXDesk's built-in
// one, Tectonic. Tectonic is a single program (downloaded once, on request) that fetches the LaTeX packages a
// document needs the first time they're used, so new users don't have to install anything else.
const path = require('path')
const fs = require('fs/promises')
const crypto = require('crypto')
const fsc = require('fs').constants

const WIN = process.platform === 'win32'
const EXE = WIN ? '.exe' : ''

// one build per platform, pinned: the download is checked against its hash before it's used
// (Linux uses the static musl builds, which run on any distribution)
const RELEASE = 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/'
const BUILDS = {
  'win32-x64': { file: 'tectonic-0.17.0-x86_64-pc-windows-msvc.zip', sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f', bytes: 21060223 },
  'linux-x64': { file: 'tectonic-0.17.0-x86_64-unknown-linux-musl.tar.gz', sha256: '8533d07f9ccbd7a65824b9e0459041bca34af1eb33daba48f59215593753a3b7', bytes: 10151914 },
  'linux-arm64': { file: 'tectonic-0.17.0-aarch64-unknown-linux-musl.tar.gz', sha256: 'b10954a95404f3ab2328d2fa59a5ebab8e657f893fab096f98be8db7c0c979b8', bytes: 9926834 },
}
const build = BUILDS[`${process.platform}-${process.arch}`]
const TECTONIC = { version: '0.17.0', ...build, url: build && RELEASE + build.file, available: !!build }

const tectonicDir = userData => path.join(userData, 'tectonic')
const tectonicExe = userData => path.join(tectonicDir(userData), 'tectonic' + EXE)
/** Where Tectonic keeps the packages it has downloaded (instead of its default under %LOCALAPPDATA%). */
const tectonicCache = userData => path.join(tectonicDir(userData), 'cache')

const exists = p => fs.stat(p).then(s => s.isFile(), () => false)

/** A program on PATH. Only PATH (never the current folder) and, on Windows, only .exe: a bare `synctex` would also match synctex.js. */
async function which(cmd) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir.replace(/^"(.*)"$/, '$1'), cmd + EXE)
    if ((await exists(file)) && (WIN || (await fs.access(file, fsc.X_OK).then(() => true, () => false)))) return file
  }
  return null
}

/**
 * What's available and what will be used. `preference` is the Settings choice: 'auto' (an installed
 * distribution if there is one, else the built-in engine), 'system' or 'tectonic'.
 */
async function status(userData, preference = 'auto') {
  const [system, builtIn, systemTectonic, biber] = await Promise.all([which('pdflatex'), exists(tectonicExe(userData)), which('tectonic'), which('biber')])
  // a Tectonic the system installed (e.g. `pacman -S tectonic`) does the same job as the built-in one
  const tectonicPath = builtIn ? tectonicExe(userData) : systemTectonic
  const tectonic = !!tectonicPath
  let engine = null
  if (preference === 'tectonic') engine = tectonic ? 'tectonic' : null
  else if (preference === 'system') engine = system ? 'system' : null
  else engine = system ? 'system' : tectonic ? 'tectonic' : null
  return { preference, engine, system, tectonic, tectonicPath, biber: !!biber, tectonicVersion: TECTONIC.version, downloadBytes: TECTONIC.bytes, canInstall: TECTONIC.available }
}

let installing = null

/** The one file named `name` in a .tar archive (Tectonic's Linux downloads hold just the program). */
function fromTar(tar, name) {
  for (let at = 0; at + 512 <= tar.length; ) {
    const field = (from, len) => tar.toString('latin1', at + from, at + from + len).split('\0')[0]
    const entry = field(0, 100)
    if (!entry) break
    const size = parseInt(field(124, 12).trim() || '0', 8)
    const type = field(156, 1)
    if (entry.replace(/^\.\//, '') === name && (type === '0' || type === '')) return tar.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
  }
  return null
}

/** Download Tectonic into the app's data folder (10–20 MB), checking it against the pinned hash. */
function installTectonic(userData, onProgress = () => {}) {
  installing ??= (async () => {
    if (!TECTONIC.available) throw new Error(`The built-in TeX engine isn't available for this computer (${process.platform} ${process.arch}). Install TeX Live or MiKTeX instead.`)
    const dir = tectonicDir(userData)
    await fs.mkdir(dir, { recursive: true })
    const res = await fetch(TECTONIC.url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`)
    const total = Number(res.headers.get('content-length')) || TECTONIC.bytes
    const chunks = []
    let received = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      onProgress({ phase: 'download', received, total, fraction: received / total })
    }
    const zip = Buffer.concat(chunks)
    const hash = crypto.createHash('sha256').update(zip).digest('hex')
    if (hash !== TECTONIC.sha256) throw new Error('The download was damaged or changed (checksum mismatch), so it was not installed. Please try again.')
    onProgress({ phase: 'unpack', fraction: 1 })
    const { unzipSync, gunzipSync } = require('fflate')
    const name = 'tectonic' + EXE
    const exe = TECTONIC.file.endsWith('.zip')
      ? unzipSync(new Uint8Array(zip), { filter: f => f.name === name })[name]
      : fromTar(Buffer.from(gunzipSync(new Uint8Array(zip))), name)
    if (!exe) throw new Error(`${name} was not in the download`)
    // write beside, then rename, so a half-written file is never mistaken for an installed engine
    await fs.writeFile(tectonicExe(userData) + '.part', exe, { mode: 0o755 })
    await fs.rename(tectonicExe(userData) + '.part', tectonicExe(userData))
    onProgress({ phase: 'done', fraction: 1 })
    return status(userData)
  })().finally(() => (installing = null))
  return installing
}

/** Arguments and environment for one Tectonic run (it reruns TeX and runs BibTeX itself). */
function tectonicCommand(userData, { mainName, outDir, program = tectonicExe(userData) }) {
  return {
    cmd: program,
    // continue-on-errors: like nonstopmode, still make a PDF when there are recoverable errors
    args: ['--outdir', outDir, '--synctex', '--keep-logs', '--keep-intermediates', '-Z', 'continue-on-errors', mainName],
    env: { ...process.env, TECTONIC_CACHE_DIR: tectonicCache(userData) },
  }
}

/** A friendlier line for Tectonic problems that its log doesn't explain. */
function tectonicHint(output) {
  if (/biber/i.test(output) && /(not found|failed|could not|cannot)/i.test(output))
    return `This document uses biblatex, which needs the "biber" program. The built-in TeX engine doesn't include it: ${WIN ? 'install MiKTeX' : 'install biber (sudo pacman -S biber, or sudo apt install biber)'}, or switch the document to BibTeX (\\bibliographystyle + \\bibliography).`
  if (/(failed to|couldn't|unable to) (download|fetch|open|connect)|dns error|error sending request|tcp connect/i.test(output))
    return 'The built-in TeX engine needs the internet the first time a document uses a package, to download it. Check your connection and compile again.'
  return null
}

module.exports = { TECTONIC, status, installTectonic, tectonicCommand, tectonicHint, tectonicExe, tectonicCache, which }
