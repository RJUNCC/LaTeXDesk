// A small SyncTeX reader, for jumping between the source and the PDF when the `synctex` command-line tool
// isn't installed (the built-in Tectonic engine doesn't come with it). Reads <base>.synctex(.gz) and answers
// the same two questions the tool does: where in the PDF is this line, and which line made this spot.
const fs = require('fs/promises')
const path = require('path')
const zlib = require('zlib')

/** Positions in the file are TeX scaled points (times Unit); the PDF viewer works in big points (1/72 in). */
const SP_TO_BP = 72 / 72.27 / 65536

function parse(text) {
  const inputs = new Map()
  let unit = 1
  let mag = 1000
  let xOff = 0
  let yOff = 0
  const nodes = []
  let page = 0
  let content = false
  // boxes still open, so each node knows the line box it sits in
  const stack = []
  for (const line of text.split(/\r?\n/)) {
    if (!content) {
      let m
      if ((m = line.match(/^Input:(\d+):(.*)$/))) inputs.set(+m[1], m[2])
      else if ((m = line.match(/^Unit:(\d+)/))) unit = +m[1]
      else if ((m = line.match(/^Magnification:(\d+)/))) mag = +m[1]
      else if ((m = line.match(/^X Offset:(-?\d+)/))) xOff = +m[1]
      else if ((m = line.match(/^Y Offset:(-?\d+)/))) yOff = +m[1]
      else if (line.startsWith('Content:')) content = true
      continue
    }
    // later Input lines may appear inside the content (files opened mid-document)
    const input = line.match(/^Input:(\d+):(.*)$/)
    if (input) {
      inputs.set(+input[1], input[2])
      continue
    }
    const kind = line[0]
    if (kind === '{') {
      page = parseInt(line.slice(1), 10)
      stack.length = 0
      continue
    }
    if (kind === ']' || kind === ')') {
      stack.pop()
      continue
    }
    if (!'[(vhxkg$'.includes(kind)) continue
    const m = line.slice(1).match(/^(\d+),(\d+)(?:,\d+)?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/)
    if (!m) continue
    const scale = (unit * mag) / 1000 * SP_TO_BP
    const node = {
      kind,
      page,
      tag: +m[1],
      line: +m[2],
      x: (+m[3] + xOff) * scale,
      y: (+m[4] + yOff) * scale,
      W: m[5] != null && m[6] != null ? +m[5] * scale : 0,
      H: m[6] != null ? +m[6] * scale : 0,
      D: m[7] != null ? +m[7] * scale : 0,
      box: stack[stack.length - 1] ?? null,
    }
    nodes.push(node)
    if (kind === '[' || kind === '(') stack.push(node)
  }
  return { inputs, nodes }
}

const isLineBox = n => n.kind === '(' || n.kind === 'h'

async function load(outDir, base) {
  for (const name of [`${base}.synctex.gz`, `${base}.synctex`]) {
    const buf = await fs.readFile(path.join(outDir, name)).catch(() => null)
    if (buf) return parse((name.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'))
  }
  return null
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

/** Source line → PDF box ({page, h, v, W, H}, in big points from the page's top-left, v on the baseline). */
function forward(data, cwd, file, line) {
  const tags = [...data.inputs].filter(([, p]) => p && samePath(path.resolve(cwd, p), file)).map(([t]) => t)
  if (!tags.length) return null
  const ofFile = data.nodes.filter(n => tags.includes(n.tag) && n.kind !== '[' && n.kind !== 'v')
  if (!ofFile.length) return null
  // A paragraph's line boxes carry the line where the paragraph *ended* (e.g. a following \[ … \]), so a node
  // only counts for its line when the box it's in is mostly made from that line, as the synctex tool decides.
  const majority = new Map()
  for (const n of data.nodes) {
    if (!n.box) continue
    const counts = majority.get(n.box) ?? new Map()
    counts.set(n.line, (counts.get(n.line) ?? 0) + 1)
    majority.set(n.box, counts)
  }
  const mainLine = box => {
    const counts = majority.get(box)
    return counts ? [...counts].sort((a, b) => b[1] - a[1])[0][0] : box.line
  }
  const belongs = n => (isLineBox(n) ? mainLine(n) : n.box ? mainLine(n.box) : n.line) === n.line
  // the line itself, or else the nearest line after it that produced output (blank lines and comments don't)
  let hit = ofFile.find(n => n.line === line && belongs(n)) ?? ofFile.find(n => n.line === line)
  if (!hit) {
    const after = ofFile.filter(n => n.line > line).sort((a, b) => a.line - b.line)[0]
    const before = ofFile.filter(n => n.line < line).sort((a, b) => b.line - a.line)[0]
    hit = after ?? before
  }
  // like the synctex tool: the first node of that line, and the line box it sits in
  const box = isLineBox(hit) ? hit : (hit.box ?? hit)
  return { page: hit.page, x: hit.x, y: hit.y, h: box.x, v: box.y + box.D, W: box.W, H: box.H + box.D }
}

/** PDF point (big points from the page's top-left) → { file (absolute), line }. */
function reverse(data, page, x, y) {
  const onPage = data.nodes.filter(n => n.page === page)
  if (!onPage.length) return null
  const inside = b => x >= b.x && x <= b.x + b.W && y >= b.y - b.H && y <= b.y + b.D
  // the smallest line box containing the point, else the nearest one
  const boxes = onPage.filter(isLineBox)
  let box = boxes.filter(inside).sort((a, b) => a.W * (a.H + a.D) - b.W * (b.H + b.D))[0]
  if (!box) {
    const dist = b => Math.hypot(Math.max(b.x - x, 0, x - (b.x + b.W)), Math.max(b.y - b.H - y, 0, y - (b.y + b.D)))
    box = boxes.sort((a, b) => dist(a) - dist(b))[0]
  }
  if (!box) return null
  // within it, the last node at or before the click (its source line is the most precise)
  const within = onPage.filter(n => n.box === box && n.x <= x).sort((a, b) => b.x - a.x)
  const best = within[0] ?? box
  const file = data.inputs.get(best.tag)
  return file ? { file, line: best.line } : null
}

module.exports = { parse, load, forward, reverse }
