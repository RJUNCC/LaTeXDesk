import { build } from 'esbuild'
import { buildParserFile } from '@lezer/generator'
import fs from 'node:fs'
import path from 'node:path'

const grammarDir = 'src/overleaf/lezer-latex'
const out = 'dist'
fs.mkdirSync(out, { recursive: true })

// Compile Overleaf's Lezer LaTeX grammar into a parser, as their webpack build does
const grammar = fs.readFileSync(path.join(grammarDir, 'latex.grammar'), 'utf8')
const { parser, terms } = buildParserFile(grammar, { fileName: 'latex.grammar', moduleStyle: 'es' })
fs.writeFileSync(path.join(grammarDir, 'latex.mjs'), parser)
fs.writeFileSync(path.join(grammarDir, 'latex.terms.mjs'), terms)

await build({
  entryPoints: ['src/renderer/main.ts'],
  outfile: path.join(out, 'renderer.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  sourcemap: true,
  minify: process.argv.includes('--minify'),
  logLevel: 'warning',
})

// spell-check worker runs Overleaf's Hunspell (WebAssembly) off the main thread
await build({
  entryPoints: ['src/renderer/spell-worker.ts'],
  outfile: path.join(out, 'spell-worker.js'),
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  minify: process.argv.includes('--minify'),
  logLevel: 'warning',
})
fs.mkdirSync(path.join(out, 'hunspell'), { recursive: true })
fs.copyFileSync('src/overleaf/hunspell/hunspell.wasm', path.join(out, 'hunspell', 'hunspell.wasm'))
fs.copyFileSync('node_modules/dictionary-en/index.dic', path.join(out, 'hunspell', 'en_US.dic'))
fs.copyFileSync('node_modules/dictionary-en/index.aff', path.join(out, 'hunspell', 'en_US.aff'))
fs.copyFileSync('src/overleaf/hunspell/en_US.txt', path.join(out, 'hunspell', 'en_US-science.txt'))

fs.copyFileSync('src/renderer/index.html', path.join(out, 'index.html'))
fs.copyFileSync('src/renderer/style.css', path.join(out, 'style.css'))
fs.copyFileSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', path.join(out, 'pdf.worker.min.mjs'))
// KaTeX stylesheet + fonts for the offline equation preview
fs.mkdirSync(path.join(out, 'katex'), { recursive: true })
fs.copyFileSync('node_modules/katex/dist/katex.min.css', path.join(out, 'katex', 'katex.min.css'))
fs.cpSync('node_modules/katex/dist/fonts', path.join(out, 'katex', 'fonts'), { recursive: true })
console.log('built dist/')
