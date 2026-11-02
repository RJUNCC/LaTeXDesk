// Which TeX engine compiles documents: an installed distribution (MiKTeX, TeX Live) or LaTeXDesk's built-in
// one, Tectonic. Tectonic is a single program (downloaded once, on request) that fetches the LaTeX packages a
// document needs the first time they're used, so new users don't have to install anything else.
const path = require('path')
const fs = require('fs/promises')
const crypto = require('crypto')
const { spawn } = require('child_process')

// pinned: the download is checked against this hash before it's used
const TECTONIC = {
  version: '0.17.0',
  url: 'https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%400.17.0/tectonic-0.17.0-x86_64-pc-windows-msvc.zip',
  sha256: 'f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f',
  bytes: 21060223,
}

const tectonicDir = userData => path.join(userData, 'tectonic')
const tectonicExe = userData => path.join(tectonicDir(userData), 'tectonic.exe')
/** Where Tectonic keeps the packages it has downloaded (instead of its default under %LOCALAPPDATA%). */
const tectonicCache = userData => path.join(tectonicDir(userData), 'cache')

const exists = p => fs.stat(p).then(s => s.isFile(), () => false)

/** A program on PATH. Only PATH and only .exe: a bare `where synctex` also matches files like synctex.js in the current folder. */
function which(cmd) {
  return new Promise(resolve => {
    const child = spawn('where', [`$PATH:${cmd}.exe`], { windowsHide: true })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.on('error', () => resolve(null))
    child.on('close', code => resolve(code === 0 ? out.split(/\r?\n/)[0].trim() : null))
  })
}

/**
 * What's available and what will be used. `preference` is the Settings choice: 'auto' (an installed
 * distribution if there is one, else the built-in engine), 'system' or 'tectonic'.
 */
async function status(userData, preference = 'auto') {
  const [system, tectonic, biber] = await Promise.all([which('pdflatex'), exists(tectonicExe(userData)), which('biber')])
  let engine = null
  if (preference === 'tectonic') engine = tectonic ? 'tectonic' : null
  else if (preference === 'system') engine = system ? 'system' : null
  else engine = system ? 'system' : tectonic ? 'tectonic' : null
  return { preference, engine, system, tectonic, biber: !!biber, tectonicVersion: TECTONIC.version, downloadBytes: TECTONIC.bytes }
}

let installing = null

/** Download Tectonic into the app's data folder (about 20 MB), checking it against the pinned hash. */
function installTectonic(userData, onProgress = () => {}) {
  installing ??= (async () => {
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
    const { unzipSync } = require('fflate')
    const exe = unzipSync(new Uint8Array(zip), { filter: f => f.name === 'tectonic.exe' })['tectonic.exe']
    if (!exe) throw new Error('tectonic.exe was not in the download')
    // write beside, then rename, so a half-written file is never mistaken for an installed engine
    await fs.writeFile(tectonicExe(userData) + '.part', exe)
    await fs.rename(tectonicExe(userData) + '.part', tectonicExe(userData))
    onProgress({ phase: 'done', fraction: 1 })
    return status(userData)
  })().finally(() => (installing = null))
  return installing
}

/** Arguments and environment for one Tectonic run (it reruns TeX and runs BibTeX itself). */
function tectonicCommand(userData, { mainName, outDir }) {
  return {
    cmd: tectonicExe(userData),
    // continue-on-errors: like nonstopmode, still make a PDF when there are recoverable errors
    args: ['--outdir', outDir, '--synctex', '--keep-logs', '--keep-intermediates', '-Z', 'continue-on-errors', mainName],
    env: { ...process.env, TECTONIC_CACHE_DIR: tectonicCache(userData) },
  }
}

/** A friendlier line for Tectonic problems that its log doesn't explain. */
function tectonicHint(output) {
  if (/biber/i.test(output) && /(not found|failed|could not|cannot)/i.test(output))
    return 'This document uses biblatex, which needs the "biber" program. The built-in TeX engine doesn\'t include it: install MiKTeX, or switch the document to BibTeX (\\bibliographystyle + \\bibliography).'
  if (/(failed to|couldn't|unable to) (download|fetch|open|connect)|dns error|error sending request|tcp connect/i.test(output))
    return 'The built-in TeX engine needs the internet the first time a document uses a package, to download it. Check your connection and compile again.'
  return null
}

module.exports = { TECTONIC, status, installTectonic, tectonicCommand, tectonicHint, tectonicExe, tectonicCache, which }
