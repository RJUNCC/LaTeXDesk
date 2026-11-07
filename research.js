// Research helpers (main process): turn a DOI / arXiv id / ISBN / URL into BibTeX, and search papers.
// Plain HTTP to public APIs; no AI and no keys involved.
const UA = 'LaTeXDesk (desktop LaTeX editor; https://github.com/RJUNCC/LaTeXDesk)'
const TIMEOUT = 15000

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(accept ? { Accept: accept } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}`)
  return res
}

// ---------- identifier detection ----------

/** Work out what the user pasted. */
// Sites that show arXiv papers under their arXiv id (alphaXiv, Hugging Face Papers, ar5iv…): look them up on arXiv
const ARXIV_MIRRORS = /^(?:www\.)?(?:alphaxiv\.org|arxiv\.org|export\.arxiv\.org|ar5iv\.labs\.arxiv\.org|ar5iv\.org|huggingface\.co|semanticscholar\.org|scirate\.com|arxiv-sanity-lite\.com)$/i

/** The arXiv id in a link to a paper on one of those sites, as a match ([, id]), or null. */
function arxivMirror(s) {
  let url
  try {
    url = new URL(s)
  } catch {
    return null
  }
  if (!ARXIV_MIRRORS.test(url.hostname)) return null
  // Hugging Face also hosts models and datasets: only its /papers/ pages are papers
  if (/huggingface\.co$/i.test(url.hostname) && !url.pathname.startsWith('/papers/')) return null
  const id = url.pathname.match(/\/(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?(?:\/|$)/)
  return id && [id[0], id[1]]
}

function identify(input) {
  const s = input.trim()
  const doi = s.match(/\b(10\.\d{4,9}\/[^\s"<>]+?)(?:[.,;)]?)$/i) || s.match(/doi\.org\/(10\.\d{4,9}\/[^\s"<>]+)/i)
  if (doi) return { kind: 'doi', id: decodeURIComponent(doi[1]) }
  const arxiv =
    s.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i) ||
    arxivMirror(s) ||
    s.match(/^(?:arxiv:)?(\d{4}\.\d{4,5}(?:v\d+)?)$/i) ||
    s.match(/^(?:arxiv:)?([a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?)$/i)
  if (arxiv) return { kind: 'arxiv', id: arxiv[1] }
  const isbn = s.replace(/[-\s]/g, '').match(/^(?:ISBN(?:-1[03])?:?)?(\d{9}[\dXx]|\d{13})$/i)
  if (isbn) return { kind: 'isbn', id: isbn[1].toUpperCase() }
  if (/^https?:\/\//i.test(s)) return { kind: 'url', id: s }
  return null
}

// ---------- BibTeX helpers ----------

const ASCII = s =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')

const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'towards', 'toward', 'from', 'via', 'at', 'by'])

/** Citation key like knuth1984texbook: first author's surname, year, first significant title word. */
function makeKey(fields) {
  const firstAuthor = (fields.author || fields.editor || 'anon').split(/\s+and\s+/i)[0]
  const surname = firstAuthor.includes(',') ? firstAuthor.split(',')[0] : firstAuthor.trim().split(/\s+/).pop()
  const year = (fields.year || '').match(/\d{4}/)?.[0] || 'nd'
  const word =
    (fields.title || '')
      .replace(/[{}\\]/g, '')
      .split(/[\s:,.-]+/)
      .map(w => w.toLowerCase())
      .find(w => w.length > 2 && !STOP.has(w)) || ''
  return `${ASCII(surname).toLowerCase() || 'anon'}${year}${ASCII(word).toLowerCase()}`
}

/** Minimal BibTeX field reader for single entries (handles nested braces and quoted values). */
function parseEntry(bib) {
  const head = bib.match(/@(\w+)\s*\{\s*([^,\s]*)\s*,/)
  if (!head) return null
  const fields = {}
  let i = head.index + head[0].length
  while (i < bib.length) {
    const m = /\s*([A-Za-z][\w-]*)\s*=\s*/y
    m.lastIndex = i
    const f = m.exec(bib)
    if (!f) break
    i = m.lastIndex
    let value = ''
    if (bib[i] === '{') {
      let depth = 0
      const start = i
      for (; i < bib.length; i++) {
        if (bib[i] === '{') depth++
        else if (bib[i] === '}' && --depth === 0) break
      }
      value = bib.slice(start + 1, i)
      i++
    } else if (bib[i] === '"') {
      const end = bib.indexOf('"', i + 1)
      value = bib.slice(i + 1, end)
      i = end + 1
    } else {
      const end = bib.slice(i).search(/[,}\n]/)
      value = bib.slice(i, i + end).trim()
      i += end
    }
    fields[f[1].toLowerCase()] = value.replace(/\s+/g, ' ').trim()
    const comma = bib.slice(i).search(/\S/)
    i += comma >= 0 && bib[i + comma] === ',' ? comma + 1 : 0
    if (comma < 0 || bib[i + (comma >= 0 ? comma : 0)] === '}') break
  }
  return { type: head[1].toLowerCase(), key: head[2], fields }
}

const FIELD_ORDER = ['author', 'editor', 'title', 'journal', 'booktitle', 'publisher', 'school', 'institution', 'year', 'month', 'volume', 'number', 'pages', 'doi', 'eprint', 'archiveprefix', 'primaryclass', 'isbn', 'url', 'urldate', 'note']

function formatEntry(type, key, fields) {
  // BibTeX convention for ranges is "--", not the Unicode dash some APIs return
  if (fields.pages) fields.pages = fields.pages.replace(/\s*[–—-]+\s*/g, '--')
  const keys = Object.keys(fields).filter(k => fields[k])
  keys.sort((a, b) => (FIELD_ORDER.indexOf(a) + 1 || 99) - (FIELD_ORDER.indexOf(b) + 1 || 99))
  const width = Math.max(...keys.map(k => k.length))
  const lines = keys.map(k => `  ${k.padEnd(width)} = {${fields[k]}}`)
  return `@${type}{${key},\n${lines.join(',\n')}\n}`
}

/** Escape characters that break BibTeX/LaTeX in values taken from plain-text APIs. */
const TEX_CHARS = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '^': '\\^{}', '~': '\\textasciitilde{}' }
const texEscape = s => s.replace(/[\\{}&%$#_^~]/g, c => TEX_CHARS[c]).replace(/\s+/g, ' ').trim()

/** "Page title | Site name" → "Page title", when the tail is the site's name (it isn't part of the title). */
function withoutSiteName(title, url, siteName = '') {
  const m = title.match(/^(.{8,}?)\s+[|·•–—-]\s+([^|·•–—]{1,40})$/)
  if (!m) return title
  const squash = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const tail = squash(m[2])
  const host = squash(new URL(url).hostname.replace(/^www\./, '').split('.')[0])
  return tail && (tail.includes(host) || host.includes(tail) || tail === squash(siteName)) ? m[1].trim() : title
}

// ---------- resolvers ----------

async function fromDoi(doi) {
  const res = await get(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`, 'application/x-bibtex; charset=utf-8')
  const text = await res.text()
  const entry = parseEntry(text)
  if (!entry) throw new Error('doi.org returned no BibTeX for this DOI')
  entry.fields.doi = entry.fields.doi || doi
  for (const f of ['author', 'editor']) if (entry.fields[f]) entry.fields[f] = fixCaps(entry.fields[f])
  return entry
}

/** Some publishers register names in capitals (CARSKADON, MARY A.); reference lists should read Carskadon, Mary A. */
function fixCaps(names) {
  // braced names ({NASA}) are left as they are
  return names.replace(/(^|[\s,'-])([A-ZÀ-Þ]{2,})(?=$|[\s,.'-])/g, (m, pre, word) => pre + word[0] + word.slice(1).toLowerCase())
}

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
  return m ? m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''
}

const decodeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&')

async function fromArxiv(id) {
  const res = await get(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`)
  const xml = await res.text()
  const entryXml = xml.split('<entry>')[1]
  if (!entryXml) throw new Error(`arXiv has no paper ${id}`)
  // a published version with a DOI gives the better citation
  const doi = entryXml.match(/<arxiv:doi[^>]*>([^<]+)<\/arxiv:doi>/)?.[1]
  if (doi) {
    try {
      const e = await fromDoi(doi.trim())
      e.fields.eprint = id.replace(/v\d+$/, '')
      e.fields.archiveprefix = 'arXiv'
      return e
    } catch {}
  }
  const authors = [...entryXml.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(m => decodeXml(m[1].trim()))
  const published = xmlText(entryXml, 'published')
  const primary = entryXml.match(/<arxiv:primary_category[^>]*term="([^"]+)"/)?.[1]
  const cleanId = id.replace(/v\d+$/, '')
  return {
    type: 'misc',
    key: '',
    fields: {
      author: authors.map(texEscape).join(' and '),
      title: texEscape(decodeXml(xmlText(entryXml, 'title'))),
      year: published.slice(0, 4),
      eprint: cleanId,
      archiveprefix: 'arXiv',
      primaryclass: primary || '',
      url: `https://arxiv.org/abs/${cleanId}`,
    },
  }
}

async function fromIsbn(isbn) {
  const res = await get(`https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`)
  const data = (await res.json())[`ISBN:${isbn}`]
  if (!data) throw new Error(`Open Library has no book with ISBN ${isbn}`)
  return {
    type: 'book',
    key: '',
    fields: {
      author: (data.authors || []).map(a => texEscape(a.name)).join(' and '),
      title: texEscape(data.title + (data.subtitle ? `: ${data.subtitle}` : '')),
      publisher: texEscape((data.publishers || []).map(p => p.name).join(', ')),
      year: (data.publish_date || '').match(/\d{4}/)?.[0] || '',
      isbn,
    },
  }
}

async function fromUrl(url) {
  // pages often embed citation metadata (Google Scholar's citation_* tags)
  const res = await get(url, 'text/html')
  const html = (await res.text()).slice(0, 400000)
  const meta = name => {
    const all = [...html.matchAll(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*content=["']([^"']+)["']`, 'gi'))].map(m => decodeXml(m[1]))
    return all
  }
  const doi = meta('citation_doi')[0] || meta('dc.identifier')[0]?.match(/10\.\d{4,9}\/\S+/)?.[0]
  if (doi) {
    try {
      return await fromDoi(doi.replace(/^doi:/i, ''))
    } catch {}
  }
  const property = name => decodeXml(html.match(new RegExp(`<meta[^>]+property=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1] ?? '')
  const title = meta('citation_title')[0] || withoutSiteName(property('og:title') || decodeXml(xmlText(html, 'title')), url, property('og:site_name'))
  const authors = meta('citation_author')
  const date = meta('citation_publication_date')[0] || meta('citation_date')[0] || ''
  return {
    type: 'misc',
    key: '',
    fields: {
      author: authors.map(texEscape).join(' and '),
      title: texEscape(title || url),
      year: date.match(/\d{4}/)?.[0] || '',
      howpublished: `\\url{${url}}`,
      url,
      urldate: new Date().toISOString().slice(0, 10),
    },
  }
}

// ---------- reading a paper ----------

const MAX_PDF = 80 * 1048576

/** The arXiv id of a source, from its eprint, a link to it (arXiv, alphaXiv…) or an arXiv DOI. */
function arxivIdOf(f) {
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(f.eprint ?? '')) return f.eprint
  for (const s of [f.url, (f.howpublished ?? '').replace(/^\\url\{(.*)\}$/, '$1')]) {
    const id = s && identify(s)
    if (id?.kind === 'arxiv') return id.id
  }
  return f.doi?.match(/^10\.48550\/arxiv\.(.+)$/i)?.[1] ?? null
}

/**
 * Where this source can be read for free: `links` are PDFs to download (arXiv for preprints, a direct .pdf link, then
 * open-access copies OpenAlex knows of); `pages` are free copies only offered on a web page (SSRN, some repositories).
 */
async function freeCopies(f) {
  const links = [], pages = []
  const arxiv = arxivIdOf(f)
  if (arxiv) links.push({ url: `https://arxiv.org/pdf/${arxiv}`, from: 'arXiv' })
  if (/^https?:\/\/\S+\.pdf(\?\S*)?$/i.test(f.url ?? '')) links.push({ url: f.url, from: new URL(f.url).hostname.replace(/^www\./, '') })
  const doi = f.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
  if (doi && !arxiv) {
    try {
      const work = await (await get(`https://api.openalex.org/works/https://doi.org/${doi}`)).json()
      for (const loc of [work.best_oa_location, ...(work.locations ?? [])])
        if (loc?.is_oa && loc.pdf_url && !links.some(l => l.url === loc.pdf_url)) links.push({ url: loc.pdf_url, from: loc.source?.display_name || new URL(loc.pdf_url).hostname })
        else if (loc?.is_oa && loc.landing_page_url && !pages.some(p => p.url === loc.landing_page_url)) pages.push({ url: loc.landing_page_url, from: loc.source?.display_name || new URL(loc.landing_page_url).hostname })
    } catch {} // OpenAlex doesn't know this DOI: only the links above
  }
  return { links, pages }
}

/** PDFs this source can be downloaded from. */
const pdfLinks = async f => (await freeCopies(f)).links

/** The file a PDF the user added for this source (from its page, or their own copy) is kept in. */
function addedPdfFile(fields, cacheDir) {
  const id = arxivIdOf(fields) || fields.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').toLowerCase() || fields.url || fields.title || ''
  return require('path').join(cacheDir, `added-${require('crypto').createHash('sha1').update(id).digest('hex').slice(0, 16)}.pdf`)
}

const isPdf = bytes => bytes.length <= MAX_PDF && Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-'

/**
 * A PDF of the source, cached in `cacheDir`: one the user added for it, else a free copy online. { bytes, from, url }.
 * Throws with a plain explanation when there isn't one; `error.page` is a page where it's free to read, if any.
 */
async function paperPdf(fields, cacheDir) {
  const fsp = require('fs/promises')
  const crypto = require('crypto')
  const path = require('path')
  const added = await fsp.readFile(addedPdfFile(fields, cacheDir)).catch(() => null)
  if (added) return { bytes: added, from: 'the copy you added' }
  const { links, pages } = await freeCopies(fields)
  for (const link of links) {
    const file = path.join(cacheDir, `${crypto.createHash('sha1').update(link.url).digest('hex').slice(0, 16)}.pdf`)
    const cached = await fsp.readFile(file).catch(() => null)
    if (cached) return { bytes: cached, from: link.from, url: link.url }
    try {
      const res = await fetch(link.url, { headers: { 'User-Agent': UA, Accept: 'application/pdf' }, redirect: 'follow', signal: AbortSignal.timeout(60000) })
      if (!res.ok || Number(res.headers.get('content-length') ?? 0) > MAX_PDF) continue
      const bytes = Buffer.from(await res.arrayBuffer())
      // publishers often answer a PDF link with a login or cookie page instead
      if (!isPdf(bytes)) continue
      await fsp.mkdir(cacheDir, { recursive: true })
      await fsp.writeFile(file, bytes)
      return { bytes, from: link.from, url: link.url }
    } catch {}
  }
  const page = pages[0]
  throw Object.assign(
    new Error(
      page
        ? `This paper is free on ${page.from}, but that site doesn’t let apps download it. Open its page, press its download button, and the PDF will show here.`
        : links.length
          ? 'The free copies of this paper couldn’t be downloaded (the site may need a login).'
          : fields.doi
            ? 'No free copy of this paper was found. It’s probably behind a paywall: your school library’s website can usually get it.'
            : 'There’s no PDF to show for this source. Papers on arXiv, and journal papers with a free copy, can be read here.'
    ),
    { page: page?.url }
  )
}

/** Keep a PDF the user got for this source (downloaded from its page, or their own file) so Read shows it from now on. */
async function addPdf(fields, cacheDir, bytes) {
  if (!isPdf(bytes)) throw new Error('That file isn’t a PDF.')
  const fsp = require('fs/promises')
  await fsp.mkdir(cacheDir, { recursive: true })
  await fsp.writeFile(addedPdfFile(fields, cacheDir), bytes)
  return { bytes, from: 'the copy you added' }
}

/** Resolve any supported identifier to { key, bibtex, entry }. */
async function cite(input) {
  const id = identify(input)
  if (!id) throw new Error('Paste a DOI (10.xxxx/…), an arXiv id (2101.00001), an ISBN, or a URL')
  const entry =
    id.kind === 'doi' ? await fromDoi(id.id) : id.kind === 'arxiv' ? await fromArxiv(id.id) : id.kind === 'isbn' ? await fromIsbn(id.id) : await fromUrl(id.id)
  const key = makeKey(entry.fields)
  return { key, kind: id.kind, type: entry.type, bibtex: formatEntry(entry.type, key, entry.fields), fields: entry.fields }
}

/**
 * Candidates for a typed title or a pasted reference ("Smith, J. (2020). Sleep and memory…"): Crossref matches
 * whole references well, and Open Library finds books. Each candidate can then go through cite() by its id.
 */
async function match(text) {
  const q = text.replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!q) return []
  const [works, books] = await Promise.allSettled([
    get(`https://api.crossref.org/works?rows=5&select=DOI,title,author,issued,container-title,publisher,type&query.bibliographic=${encodeURIComponent(q)}`).then(r => r.json()),
    get(`https://openlibrary.org/search.json?limit=3&fields=title,subtitle,author_name,first_publish_year,isbn,publisher&q=${encodeURIComponent(q.slice(0, 200))}`).then(r => r.json()),
  ])
  const out = []
  for (const w of works.status === 'fulfilled' ? works.value.message?.items ?? [] : []) {
    if (!w.DOI || !w.title?.[0]) continue
    out.push({
      id: w.DOI,
      kind: 'doi',
      title: decodeXml(w.title[0].replace(/<[^>]+>/g, '')),
      authors: (w.author ?? []).map(a => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
      year: w.issued?.['date-parts']?.[0]?.[0] ?? null,
      venue: w['container-title']?.[0] || w.publisher || '',
      type: w.type,
    })
  }
  for (const b of books.status === 'fulfilled' ? books.value.docs ?? [] : []) {
    const isbn = (b.isbn ?? []).find(i => i.length === 13) ?? b.isbn?.[0]
    if (!isbn || !b.title) continue
    out.push({
      id: isbn,
      kind: 'isbn',
      title: b.title + (b.subtitle ? `: ${b.subtitle}` : ''),
      authors: b.author_name ?? [],
      year: b.first_publish_year ?? null,
      venue: b.publisher?.[0] ?? '',
      type: 'book',
    })
  }
  if (!out.length && works.status === 'rejected' && books.status === 'rejected') throw new Error(`Couldn't reach the lookup services (${works.reason.message}). Check the internet connection.`)
  return out
}

// ---------- search ----------

async function search(query) {
  try {
    const res = await get(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=12&fields=title,authors,year,abstract,citationCount,venue,externalIds,url`
    )
    const data = await res.json()
    return (data.data || []).map(p => ({
      title: p.title,
      authors: (p.authors || []).map(a => a.name),
      year: p.year,
      venue: p.venue,
      abstract: p.abstract,
      citations: p.citationCount,
      doi: p.externalIds?.DOI,
      arxiv: p.externalIds?.ArXiv,
      url: p.url,
      source: 'Semantic Scholar',
    }))
  } catch (e) {
    // rate-limited or down: arXiv's search is the fallback
    const res = await get(`https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=12`)
    const xml = await res.text()
    return xml
      .split('<entry>')
      .slice(1)
      .map(ex => {
        const id = xmlText(ex, 'id').replace(/^https?:\/\/arxiv\.org\/abs\//, '')
        return {
          title: decodeXml(xmlText(ex, 'title')),
          authors: [...ex.matchAll(/<author>\s*<name>([^<]+)<\/name>/g)].map(m => decodeXml(m[1].trim())),
          year: Number(xmlText(ex, 'published').slice(0, 4)) || null,
          venue: 'arXiv',
          abstract: decodeXml(xmlText(ex, 'summary')),
          citations: null,
          doi: ex.match(/<arxiv:doi[^>]*>([^<]+)</)?.[1],
          arxiv: id.replace(/v\d+$/, ''),
          url: `https://arxiv.org/abs/${id}`,
          source: /429/.test(e.message) ? 'arXiv (Semantic Scholar is busy right now)' : 'arXiv (Semantic Scholar unavailable)',
        }
      })
  }
}

/** A paper's abstract by DOI: Semantic Scholar, falling back to Crossref. */
async function abstractFor(doi) {
  try {
    const res = await get(`https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,abstract`)
    const data = await res.json()
    if (data.abstract) return { title: data.title, abstract: data.abstract, source: 'Semantic Scholar' }
  } catch {}
  const res = await get(`https://api.crossref.org/works/${encodeURIComponent(doi)}`)
  const msg = (await res.json()).message ?? {}
  const abstract = (msg.abstract ?? '').replace(/<[^>]+>/g, ' ').replace(/s+/g, ' ').trim()
  return abstract ? { title: (msg.title ?? [])[0], abstract, source: 'Crossref' } : null
}

/** Free web evidence candidates for a claim: paper abstracts (Semantic Scholar/arXiv) and Wikipedia summaries. */
async function webEvidence(claim) {
  const out = []
  try {
    for (const p of (await search(claim)).slice(0, 4)) {
      if (p.abstract) out.push({ kind: 'paper', title: p.title, year: p.year, text: p.abstract.slice(0, 1500), url: p.url, doi: p.doi, arxiv: p.arxiv })
    }
  } catch {}
  try {
    const res = await get(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(claim.slice(0, 200))}&limit=2`)
    for (const page of (await res.json()).pages ?? []) {
      const sum = await (await get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`)).json()
      if (sum.extract) out.push({ kind: 'wikipedia', title: sum.title, year: null, text: sum.extract.slice(0, 1500), url: sum.content_urls?.desktop?.page })
    }
  } catch {}
  return out
}

module.exports = { cite, match, fixCaps, withoutSiteName, texEscape, paperPdf, addPdf, pdfLinks, arxivIdOf, search, identify, makeKey, parseEntry, formatEntry, abstractFor, webEvidence }
