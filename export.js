// Submission export (main process): a single flattened .tex, comments stripped, the .bbl, and only the
// files the document actually uses, zipped and then test-compiled in a clean folder.
const path = require('path')
const os = require('os')
const fs = require('fs/promises')
const { spawn } = require('child_process')
const { zipSync, unzipSync, strToU8 } = require('fflate')

const VERBATIM = /\\begin\{(verbatim\*?|Verbatim\*?|lstlisting|minted|comment|filecontents\*?)\}/
const GRAPHIC_EXTS = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps']

const exists = p => fs.stat(p).then(s => s.isFile(), () => false)

/** Inline \input/\include recursively (paths resolve against the main file's folder, as TeX does). */
async function flatten(file, baseDir, seen = new Set()) {
  if (seen.has(file)) return `% (skipped repeated \\input of ${path.relative(baseDir, file)})\n`
  seen.add(file)
  const text = await fs.readFile(file, 'utf8')
  const out = []
  for (const line of text.split(/\r?\n/)) {
    const code = line.replace(/(^|[^\\])%.*$/, '$1')
    const m = code.match(/\\(input|include)\s*\{([^}]+)\}/)
    if (!m) {
      out.push(line)
      continue
    }
    let target = path.resolve(baseDir, m[2].trim())
    if (!path.extname(target) || !(await exists(target))) target += '.tex'
    if (!(await exists(target))) {
      out.push(line) // leave it for TeX to complain about
      continue
    }
    const inner = await flatten(target, baseDir, seen)
    const before = code.slice(0, m.index)
    const after = code.slice(m.index + m[0].length)
    out.push(`${before}${m[1] === 'include' ? '\\clearpage\n' : ''}${inner.replace(/\n$/, '')}${m[1] === 'include' ? '\n\\clearpage' : ''}${after}`)
  }
  return out.join('\n') + '\n'
}

/** Remove comments outside verbatim-like environments; keep a bare % where it protects a line end. */
function stripComments(tex) {
  const out = []
  let verbatimEnd = null
  for (const line of tex.split('\n')) {
    if (verbatimEnd) {
      out.push(line)
      if (line.includes(verbatimEnd)) verbatimEnd = null
      continue
    }
    const v = line.match(VERBATIM)
    if (v) {
      out.push(line)
      if (!line.includes(`\\end{${v[1]}}`)) verbatimEnd = `\\end{${v[1]}}`
      continue
    }
    const m = line.match(/(^|[^\\])(\\\\)*%/)
    if (!m) {
      out.push(line)
      continue
    }
    const cut = m.index + m[0].length - 1
    const kept = line.slice(0, cut)
    if (!kept.trim()) continue // whole-line comment
    out.push(`${kept}%`)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

/** Files the flattened document needs: graphics, local packages/classes/styles. */
async function dependencies(tex, baseDir) {
  const found = new Map() // project-relative path -> absolute path
  const warnings = []
  const graphicsPaths = [...(tex.match(/\\graphicspath\s*\{((?:\{[^}]*\})+)\}/)?.[1].matchAll(/\{([^}]*)\}/g) ?? [])].map(m => m[1])
  for (const m of tex.matchAll(/\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
    let hit = null
    for (const dir of ['', ...graphicsPaths]) {
      for (const ext of GRAPHIC_EXTS) {
        const candidate = path.resolve(baseDir, dir, m[1].trim() + ext)
        if (await exists(candidate)) {
          hit = candidate
          break
        }
      }
      if (hit) break
    }
    if (hit) found.set(path.relative(baseDir, hit).split(path.sep).join('/'), hit)
    else warnings.push(`Figure not found: ${m[1]}`)
  }
  const local = [
    ...[...tex.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].flatMap(m => m[1].split(',').map(n => `${n.trim()}.sty`)),
    ...[...tex.matchAll(/\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)].map(m => `${m[1].trim()}.cls`),
    ...[...tex.matchAll(/\\bibliographystyle\s*\{([^}]+)\}/g)].map(m => `${m[1].trim()}.bst`),
  ]
  for (const name of local) {
    const p = path.resolve(baseDir, name)
    if (await exists(p)) found.set(name, p)
  }
  return { files: found, warnings }
}

function run(cmd, args, cwd) {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, windowsHide: true })
    let output = ''
    child.stdout.on('data', d => (output += d))
    child.stderr.on('data', d => (output += d))
    const timer = setTimeout(() => child.kill(), 120000)
    child.on('error', e => (clearTimeout(timer), resolve({ code: -1, output: String(e) })))
    child.on('close', code => (clearTimeout(timer), resolve({ code, output })))
  })
}

/**
 * Build the submission zip at `zipPath`. `outDir` holds the last compile (for the .bbl).
 * Resolves to a report: files included, warnings, and whether the zip compiled on its own.
 */
async function exportSubmission({ root, mainFile, outDir, zipPath }) {
  const mainPath = path.resolve(root, mainFile)
  const baseDir = path.dirname(mainPath)
  const base = path.basename(mainFile, path.extname(mainFile))
  const warnings = []

  const tex = stripComments(await flatten(mainPath, baseDir))
  const deps = await dependencies(tex, baseDir)
  warnings.push(...deps.warnings)

  const entries = { [`${base}.tex`]: strToU8(tex) }
  for (const [rel, abs] of deps.files) entries[rel] = new Uint8Array(await fs.readFile(abs))
  const usesBib = /\\bibliography\s*\{|\\printbibliography/.test(tex)
  if (usesBib) {
    const bbl = path.join(outDir, `${base}.bbl`)
    if (await exists(bbl)) entries[`${base}.bbl`] = new Uint8Array(await fs.readFile(bbl))
    else warnings.push('No .bbl found: compile once (with the bibliography) before exporting')
  }
  if (/\\addbibresource/.test(tex)) warnings.push('biblatex: some archives (arXiv) need the .bbl from their own biber version; check the log after upload')
  const zip = zipSync(entries, { level: 9 })
  await fs.writeFile(zipPath, zip)

  // prove it builds on its own: unzip into a clean temp folder and compile twice
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'texdesk-export-'))
  let compiled = false
  let errors = []
  try {
    for (const [name, data] of Object.entries(unzipSync(zip))) {
      await fs.mkdir(path.dirname(path.join(tmp, name)), { recursive: true })
      await fs.writeFile(path.join(tmp, name), data)
    }
    const engine = tex.match(/^%\s*!TEX\s+(?:TS-)?program\s*=\s*(pdflatex|xelatex|lualatex)/im)?.[1] ?? 'pdflatex'
    const args = ['-interaction=nonstopmode', '-file-line-error', `${base}.tex`]
    await run(engine, args, tmp)
    const second = await run(engine, args, tmp)
    const log = await fs.readFile(path.join(tmp, `${base}.log`), 'utf8').catch(() => second.output)
    errors = [...log.matchAll(/^(?:.*?\.tex:\d+: |! )(.+)$/gm)].map(m => m[1]).slice(0, 10)
    compiled = (await exists(path.join(tmp, `${base}.pdf`))) && errors.length === 0
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
  return { zipPath, files: Object.keys(entries), bytes: zip.length, warnings, compiled, errors }
}

module.exports = { exportSubmission, flatten, stripComments }
