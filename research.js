// Research helpers (main process): turn a DOI / arXiv id / ISBN / URL into BibTeX, and search papers.
// Plain HTTP to public APIs; no AI and no keys involved.
const UA = 'LaTeXDesk/0.7 (desktop LaTeX editor)'
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
function identify(input) {
  const s = input.trim()
  const doi = s.match(/\b(10\.\d{4,9}\/[^\s"<>]+?)(?:[.,;)]?)$/i) || s.match(/doi\.org\/(10\.\d{4,9}\/[^\s"<>]+)/i)
  if (doi) return { kind: 'doi', id: decodeURIComponent(doi[1]) }
  const arxiv =
    s.match(/arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#].*)?$/i) ||
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
const texEscape = s => s.replace(/\\/g, '\\textbackslash{}').replace(/([&%$#_])/g, '\\$1').replace(/\s+/g, ' ').trim()

// ---------- resolvers ----------

async function fromDoi(doi) {
  const res = await get(`https://doi.org/${encodeURIComponent(doi).replace(/%2F/g, '/')}`, 'application/x-bibtex; charset=utf-8')
  const text = await res.text()
  const entry = parseEntry(text)
  if (!entry) throw new Error('doi.org returned no BibTeX for this DOI')
  entry.fields.doi = entry.fields.doi || doi
  return entry
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
  const title = meta('citation_title')[0] || decodeXml(xmlText(html, 'title'))
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

/** Resolve any supported identifier to { key, bibtex, entry }. */
async function cite(input) {
  const id = identify(input)
  if (!id) throw new Error('Paste a DOI (10.xxxx/…), an arXiv id (2101.00001), an ISBN, or a URL')
  const entry =
    id.kind === 'doi' ? await fromDoi(id.id) : id.kind === 'arxiv' ? await fromArxiv(id.id) : id.kind === 'isbn' ? await fromIsbn(id.id) : await fromUrl(id.id)
  const key = makeKey(entry.fields)
  return { key, kind: id.kind, type: entry.type, bibtex: formatEntry(entry.type, key, entry.fields), fields: entry.fields }
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

module.exports = { cite, search, identify, makeKey, parseEntry, formatEntry, abstractFor, webEvidence }
