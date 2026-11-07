// Sources without BibTeX: the plain-language "fill it in yourself" form, RIS files (EasyBib, Scribbr, Mendeley,
// EndNote) and lookups all become .bib entries here, and entries become readable references again.

export type Fields = Record<string, string>
export type FieldDef = { name: string; label: string; placeholder?: string; multiline?: boolean; options?: [string, string][] }
export type SourceType = { id: string; label: string; bibtype: string; fields: FieldDef[] }

const TODAY = () => new Date().toISOString().slice(0, 10)
const AUTHOR: FieldDef = { name: 'author', label: 'Author(s)', placeholder: 'One per line, like Jane Smith, or an organization', multiline: true }
const TITLE: FieldDef = { name: 'title', label: 'Title' }
const YEAR: FieldDef = { name: 'year', label: 'Year', placeholder: 'e.g. 2024' }
const URL_: FieldDef = { name: 'url', label: 'Web address (URL)', placeholder: 'https://…' }
const VISITED: FieldDef = { name: 'urldate', label: 'Date you looked at it', placeholder: 'YYYY-MM-DD' }

export const SOURCE_TYPES: SourceType[] = [
  { id: 'website', label: 'Website', bibtype: 'misc', fields: [AUTHOR, { name: 'title', label: 'Page title' }, { name: 'howpublished', label: 'Website name', placeholder: 'e.g. BBC News' }, YEAR, URL_, VISITED] },
  { id: 'article', label: 'Journal article', bibtype: 'article', fields: [AUTHOR, { name: 'title', label: 'Article title' }, { name: 'journal', label: 'Journal' }, YEAR, { name: 'volume', label: 'Volume' }, { name: 'number', label: 'Issue' }, { name: 'pages', label: 'Pages', placeholder: 'e.g. 12-34' }, { name: 'doi', label: 'DOI (if it has one)', placeholder: '10.…' }] },
  { id: 'book', label: 'Book', bibtype: 'book', fields: [AUTHOR, TITLE, { name: 'publisher', label: 'Publisher' }, YEAR, { name: 'edition', label: 'Edition', placeholder: 'e.g. 2nd' }, { name: 'address', label: 'City (optional)' }] },
  { id: 'chapter', label: 'Chapter in a book', bibtype: 'incollection', fields: [AUTHOR, { name: 'title', label: 'Chapter title' }, { name: 'booktitle', label: 'Book title' }, { name: 'editor', label: 'Editor(s) of the book', placeholder: 'One per line', multiline: true }, { name: 'publisher', label: 'Publisher' }, YEAR, { name: 'pages', label: 'Pages', placeholder: 'e.g. 12-34' }] },
  { id: 'news', label: 'News or magazine', bibtype: 'article', fields: [AUTHOR, { name: 'title', label: 'Article title' }, { name: 'journal', label: 'Newspaper or magazine' }, YEAR, URL_, VISITED] },
  { id: 'video', label: 'Video', bibtype: 'misc', fields: [{ ...AUTHOR, label: 'Creator or channel' }, TITLE, { name: 'howpublished', label: 'Where it’s posted', placeholder: 'e.g. YouTube' }, YEAR, URL_, VISITED] },
  { id: 'report', label: 'Report', bibtype: 'techreport', fields: [AUTHOR, TITLE, { name: 'institution', label: 'Organization that published it' }, YEAR, { name: 'number', label: 'Report number (optional)' }, URL_] },
  { id: 'thesis', label: 'Thesis', bibtype: 'phdthesis', fields: [AUTHOR, TITLE, { name: 'school', label: 'University' }, YEAR, { name: 'kind', label: 'Kind', options: [['phdthesis', 'PhD thesis'], ['mastersthesis', 'Master’s thesis']] }] },
  { id: 'other', label: 'Something else', bibtype: 'misc', fields: [AUTHOR, TITLE, { name: 'howpublished', label: 'Where it’s from' }, YEAR, URL_, { name: 'note', label: 'Notes (optional)' }] },
]

export const sourceType = (id: string) => SOURCE_TYPES.find(t => t.id === id) ?? SOURCE_TYPES[0]

/** Default values for a new source of this type. */
export const blankValues = (typeId: string): Fields => (sourceType(typeId).fields.some(f => f.name === 'urldate') ? { urldate: TODAY() } : typeId === 'thesis' ? { kind: 'phdthesis' } : {})

// ---------- text ----------

const TEX_CHARS: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '&': '\\&', '%': '\\%', $: '\\$', '#': '\\#', _: '\\_', '^': '\\^{}', '~': '\\textasciitilde{}' }

/** Escape what breaks LaTeX in typed text (& % $ # _ ^ ~ and stray braces), keeping it readable. */
export const texEscape = (s: string) => s.replace(/[\\{}&%$#_^~]/g, c => TEX_CHARS[c]).replace(/\s+/g, ' ').trim()

// Fields LaTeX reads as addresses or identifiers (through \url and friends), never as text
const NOT_TEXT = new Set(['url', 'doi', 'eprint', 'isbn', 'issn', 'urldate', 'file', 'archiveprefix', 'primaryclass'])

/** The position of the } that closes the { at `open` (the end of the text if it's never closed). */
function closingBrace(s: string, open: number) {
  for (let i = open, depth = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '{') depth++
    else if (s[i] === '}' && --depth === 0) return i
  }
  return s.length - 1
}

/**
 * BibTeX field text made safe for LaTeX: & % # _ ^ outside maths are escaped, and a lone $ (a price) becomes \$.
 * Text that's already LaTeX (\&, $x^2$, \^{o}, \url{…}) is kept, so this is safe to run on any source.
 */
export function texSafe(s: string) {
  let dollars = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++
    else if (s[i] === '$') dollars++
  }
  let out = ''
  let math = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const name = /^[A-Za-z]+/.exec(s.slice(i + 1))?.[0]
      if (!name) {
        out += s.slice(i, i + 2)
        i++
        continue
      }
      out += `\\${name}`
      i += name.length
      // \url{…} and \href{…} hold addresses: their argument stays as it is
      if ((name === 'url' || name === 'href') && s[i + 1] === '{') {
        const end = closingBrace(s, i + 1)
        out += s.slice(i + 1, end + 1)
        i = end
      }
      continue
    }
    if (c === '$' && dollars % 2 === 0) {
      math = !math
      out += c
    } else if (math || !'&%#_^$'.includes(c)) out += c
    else out += c === '^' ? '\\^{}' : `\\${c}`
  }
  return out
}

/** Text fields that texSafe would change: each with its current and its safe value. */
export function unsafeFields(fields: Fields) {
  return Object.entries(fields)
    .filter(([name]) => !NOT_TEXT.has(name))
    .map(([name, value]) => ({ name, value, fixed: texSafe(value) }))
    .filter(f => f.fixed !== f.value)
}

/** Fields with their text made LaTeX-safe. */
export const safeFields = (fields: Fields): Fields => Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, NOT_TEXT.has(k) ? v : texSafe(v)]))

/** An entry's BibTeX text with its fields made LaTeX-safe, changing only the values that need it. */
export function safeEntry(raw: string, fields: Fields) {
  let out = raw
  for (const f of unsafeFields(fields)) {
    const braced = out.includes(`{${f.value}}`)
    out = out.replace(braced ? `{${f.value}}` : `"${f.value}"`, () => `{${f.fixed}}`)
  }
  return out
}

const ACCENTS: Record<string, Record<string, string>> = {
  '"': { a: 'ä', o: 'ö', u: 'ü', e: 'ë', i: 'ï', A: 'Ä', O: 'Ö', U: 'Ü' },
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', c: 'ć', n: 'ń', s: 'ś', z: 'ź', E: 'É', A: 'Á' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', E: 'È', A: 'À' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', N: 'Ñ' },
  c: { c: 'ç', C: 'Ç', s: 'ş' },
}

/** BibTeX field text as plain reading text: accents, escapes, dashes and braces resolved. */
export function plain(s = '') {
  return s
    .replace(/\\\^\{\}/g, '\u0001')
    .replace(/\\textasciitilde(\{\})?/g, '\u0002')
    .replace(/\{?\\(["'`^~c])\s*\{?\\?([a-zA-Z])\}?\}?/g, (m, acc: string, ch: string) => ACCENTS[acc]?.[ch] ?? ch)
    .replace(/\\textbackslash(\{\})?/g, '\\')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\(url|href|emph|textit|textbf|textsc|mbox)\s*\{([^}]*)\}/g, '$2')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '^')
    .replace(/\u0002/g, '~')
    .replace(/\s+/g, ' ')
    .trim()
}

// ---------- people ----------

const ORG_WORDS = /\b(organi[sz]ation|association|society|institute|institution|university|college|department|ministry|agency|council|committee|office|foundation|bureau|center|centre|corporation|company|inc|ltd|llc|group|government|service|board|commission|network|news|press|union|federation|team)\b/i

const isOrganization = (name: string) => ORG_WORDS.test(name) || name.split(/\s+/).length > 4 || (/^[A-Z0-9&.\-]{2,}$/.test(name) && !name.includes('.'))

/** One person or organization per line ("Jane Smith", "Smith, Jane", "World Health Organization") → BibTeX names. */
export function toBibNames(text: string) {
  return text
    .split(/\n|;/)
    .map(s => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .map(name => {
      if (isOrganization(name)) return `{${texEscape(name)}}`
      if (name.includes(',')) return texEscape(name)
      const words = name.split(' ')
      if (words.length === 1) return texEscape(name)
      // keep surname particles with the surname: van Gogh, de la Cruz
      let i = words.length - 1
      while (i > 1 && /^(van|von|der|den|de|la|le|da|di|du|del|della|dos|bin|al)$/i.test(words[i - 1])) i--
      return `${texEscape(words.slice(i).join(' '))}, ${texEscape(words.slice(0, i).join(' '))}`
    })
    .join(' and ')
}

/** Split a BibTeX name list ("Smith, Jane and {World Health Organization}") at top-level "and"s. */
function splitNames(s = '') {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '{') depth++
    else if (c === '}') depth--
    if (depth === 0 && /\s/.test(c) && /^and\s/i.test(s.slice(i + 1))) {
      out.push(cur.trim())
      cur = ''
      i += 4
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

type Person = { org: boolean; last: string; first: string }

function people(s = ''): Person[] {
  return splitNames(s).map(n => {
    if (/^\{.*\}$/.test(n) && !n.slice(1, -1).includes('{')) return { org: true, last: plain(n), first: '' }
    if (n.includes(',')) {
      const [last, ...rest] = n.split(',')
      return { org: false, last: plain(last), first: plain(rest.join(',')) }
    }
    const words = plain(n).split(' ')
    return { org: false, last: words.pop() ?? '', first: words.join(' ') }
  })
}

/** BibTeX names back to the form's one-per-line text. */
export const fromBibNames = (s = '') => people(s).map(p => (p.org || !p.first ? p.last : `${p.first} ${p.last}`)).join('\n')

const initials = (first: string) =>
  first
    .split(/[\s.]+/)
    .filter(Boolean)
    .map(w => (w.includes('-') ? w.split('-').map(x => `${x[0]}.`).join('-') : `${w[0]}.`))
    .join(' ')

// ---------- readable references ----------

const yearOf = (f: Fields) => f.year?.match(/\d{4}/)?.[0] ?? f.date?.match(/\d{4}/)?.[0] ?? ''

/** "Smith & Lee", "Smith et al.", "World Health Organization": names for an in-text citation. */
export function citeNames(f: Fields) {
  const list = people(f.author || f.editor)
  if (!list.length) return plain(f.title).split(' ').slice(0, 3).join(' ') || 'Unknown'
  if (list.length === 1) return list[0].last
  if (list.length === 2) return `${list[0].last} & ${list[1].last}`
  return `${list[0].last} et al.`
}

/** The in-text label a citation of this source reads as, e.g. { who: 'Smith & Lee', year: '2020' }. */
export const citeLabel = (f: Fields) => ({ who: citeNames(f), year: yearOf(f) || 'n.d.' })

/** A short APA-like reference for lists and previews (not the final formatting, which the style does). */
export function readableReference(f: Fields) {
  const list = people(f.author || f.editor)
  const names = list.map(p => (p.org || !p.first ? p.last : `${p.last}, ${initials(p.first)}`))
  const who = names.length > 3 ? `${names[0]}, et al.` : names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names.at(-1)}` : names[0] ?? ''
  const where = plain(f.journal || f.booktitle || f.howpublished || f.publisher || f.school || f.institution || '')
  const parts = [who && `${who.replace(/\.$/, '')}.`, `(${yearOf(f) || 'n.d.'}).`, plain(f.title) && `${plain(f.title).replace(/[.?!]$/, '')}.`, where && `${where.replace(/\.$/, '')}.`]
  return parts.filter(Boolean).join(' ')
}

// ---------- form ⇄ entry ----------

const humanDate = (iso: string) => {
  const d = new Date(`${iso}T12:00:00`)
  return isNaN(+d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/**
 * The form's values as a BibTeX entry type and fields. With `base` (editing), fields the form doesn't show,
 * like an abstract from a lookup, are kept.
 */
export function formToEntry(typeId: string, values: Fields, base: Fields = {}): { bibtype: string; fields: Fields } {
  const t = sourceType(typeId)
  const fields: Fields = { ...base }
  for (const def of t.fields) {
    const v = (values[def.name] ?? '').trim()
    if (def.name === 'kind') continue
    if (!v) delete fields[def.name]
    else if (def.name === 'author' || def.name === 'editor') fields[def.name] = toBibNames(v)
    else if (def.name === 'url') fields.url = v.replace(/\s+/g, '')
    else if (def.name === 'doi') fields.doi = v.replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '')
    else if (def.name === 'pages') fields.pages = v.replace(/\s*[-–—]+\s*/g, '--')
    else if (def.name === 'urldate') fields.urldate = v
    else fields[def.name] = texEscape(v)
  }
  // most BibTeX styles ignore urldate, so say when the page was visited in a note too
  if (fields.urldate && fields.url) {
    const accessed = `Accessed ${humanDate(fields.urldate)}`
    fields.note = fields.note && !/^Accessed /.test(fields.note) ? `${fields.note.replace(/\.?\s*Accessed [^.]*$/, '')}. ${accessed}` : accessed
  } else if (fields.note && /^Accessed /.test(fields.note) && !fields.url) delete fields.note
  const bibtype = typeId === 'thesis' ? (values.kind === 'mastersthesis' ? 'mastersthesis' : 'phdthesis') : t.bibtype
  return { bibtype, fields }
}

/** Which form type best fits an entry. */
export function typeForEntry(bibtype: string, f: Fields) {
  const t = bibtype.toLowerCase()
  if (t === 'book') return 'book'
  if (t === 'incollection' || t === 'inbook' || t === 'inproceedings' || t === 'conference') return 'chapter'
  if (t === 'techreport' || t === 'report') return 'report'
  if (t === 'phdthesis' || t === 'mastersthesis' || t === 'thesis') return 'thesis'
  if (t === 'article') return !f.volume && !f.doi && f.url ? 'news' : 'article'
  if (t === 'misc' || t === 'online' || t === 'electronic') {
    if (/youtube|vimeo|tiktok|video/i.test(`${f.howpublished} ${f.url}`)) return 'video'
    if (f.url) return 'website'
  }
  return 'other'
}

/** An entry's fields as the form's plain-text values. */
export function entryToForm(bibtype: string, f: Fields): { typeId: string; values: Fields } {
  const typeId = typeForEntry(bibtype, f)
  const values: Fields = {}
  for (const def of sourceType(typeId).fields) {
    const v = f[def.name]
    if (def.name === 'kind') values.kind = bibtype.toLowerCase() === 'mastersthesis' ? 'mastersthesis' : 'phdthesis'
    else if (!v) continue
    else if (def.name === 'author' || def.name === 'editor') values[def.name] = fromBibNames(v)
    else if (def.name === 'url' || def.name === 'urldate' || def.name === 'doi') values[def.name] = v
    else if (def.name === 'pages') values.pages = v.replace(/--/g, '-')
    else if (def.name === 'note') values.note = plain(v.replace(/\.?\s*Accessed [^.]*$/, ''))
    else values[def.name] = plain(v)
  }
  // websites without a separate site name from older entries: howpublished may hold \url{…}
  if (values.howpublished && /^https?:/.test(values.howpublished)) {
    values.url = values.url || values.howpublished
    delete values.howpublished
  }
  return { typeId, values }
}

// ---------- keys and BibTeX text ----------

const ASCII = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
const STOP = new Set(['a', 'an', 'the', 'on', 'of', 'in', 'for', 'and', 'to', 'with', 'towards', 'toward', 'from', 'via', 'at', 'by', 'how', 'what', 'why', 'is', 'are'])

/** A citation key like smith2020sleep (who2023sleep for organizations), unique among `taken`. */
export function makeKey(f: Fields, taken: Set<string> = new Set()) {
  const first = people(f.author || f.editor)[0]
  const who = !first ? 'anon' : first.org ? first.last.split(/\s+/).filter(w => !STOP.has(w.toLowerCase())).map(w => w[0]).join('') : first.last
  const word = plain(f.title)
    .split(/[\s:,.?!'"’-]+/)
    .map(w => w.toLowerCase())
    .find(w => w.length > 2 && !STOP.has(w))
  const base = `${ASCII(who).toLowerCase() || 'anon'}${yearOf(f) || 'nd'}${ASCII(word ?? '').toLowerCase()}`
  let key = base
  for (let i = 0; taken.has(key); i++) key = base + String.fromCharCode(97 + (i % 26)) + (i >= 26 ? Math.floor(i / 26) : '')
  return key
}

const FIELD_ORDER = ['author', 'editor', 'title', 'journal', 'booktitle', 'howpublished', 'publisher', 'school', 'institution', 'edition', 'address', 'year', 'month', 'volume', 'number', 'pages', 'doi', 'isbn', 'url', 'urldate', 'note']

/** BibTeX text for one entry, fields in the usual order. */
export function formatEntry(bibtype: string, key: string, fields: Fields) {
  const keys = Object.keys(fields).filter(k => fields[k])
  keys.sort((a, b) => (FIELD_ORDER.indexOf(a) + 1 || 99) - (FIELD_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b))
  const width = Math.max(0, ...keys.map(k => k.length))
  return `@${bibtype}{${key},\n${keys.map(k => `  ${k.padEnd(width)} = {${fields[k]}}`).join(',\n')}\n}`
}

// ---------- RIS ----------

const RIS_TYPES: Record<string, string> = {
  JOUR: 'article', JFULL: 'article', MGZN: 'article', NEWS: 'article', EJOUR: 'article',
  BOOK: 'book', EBOOK: 'book', CHAP: 'incollection', ECHAP: 'incollection', CONF: 'inproceedings', CPAPER: 'inproceedings',
  RPRT: 'techreport', THES: 'phdthesis', ELEC: 'misc', WEB: 'misc', VIDEO: 'misc', MPCT: 'misc', BLOG: 'misc', GEN: 'misc',
}

/** Parse RIS (the export format of EasyBib, Scribbr, Mendeley, EndNote, most library sites) into entries. */
export function parseRis(text: string): { bibtype: string; fields: Fields }[] {
  const out: { bibtype: string; fields: Fields }[] = []
  let cur: { ty: string; tags: [string, string][] } | null = null
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const m = line.match(/^([A-Z][A-Z0-9])\s{1,2}-\s?(.*)$/)
    if (!m) continue
    const [, tag, value] = m
    if (tag === 'TY') cur = { ty: value.trim(), tags: [] }
    else if (tag === 'ER') {
      if (cur) out.push(risEntry(cur.ty, cur.tags))
      cur = null
    } else cur?.tags.push([tag, value.trim()])
  }
  if (cur?.tags.length) out.push(risEntry(cur.ty, cur.tags))
  return out
}

function risEntry(ty: string, tags: [string, string][]) {
  const all = (...names: string[]) => tags.filter(([t]) => names.includes(t)).map(([, v]) => v).filter(Boolean)
  const one = (...names: string[]) => all(...names)[0] ?? ''
  const bibtype = RIS_TYPES[ty] ?? 'misc'
  const fields: Fields = {}
  const names = (list: string[]) => list.map(n => (n.includes(',') ? texEscape(n.replace(/,\s*$/, '')) : isOrganization(n) || !n.includes(' ') ? `{${texEscape(n)}}` : toBibNames(n))).join(' and ')
  const authors = all('AU', 'A1')
  if (authors.length) fields.author = names(authors)
  const editors = all('ED', 'A2').filter(() => bibtype === 'incollection' || bibtype === 'inproceedings')
  if (editors.length) fields.editor = names(editors)
  const title = one('TI', 'T1', 'CT')
  if (title) fields.title = texEscape(title)
  const container = one('T2', 'JO', 'JF', 'JA', 'BT')
  if (container) {
    if (bibtype === 'article') fields.journal = texEscape(container)
    else if (bibtype === 'incollection' || bibtype === 'inproceedings') fields.booktitle = texEscape(container)
    else if (bibtype === 'misc') fields.howpublished = texEscape(container)
  }
  const year = one('PY', 'Y1', 'DA').match(/\d{4}/)?.[0]
  if (year) fields.year = year
  const sp = one('SP')
  const ep = one('EP')
  if (sp) fields.pages = ep ? `${sp}--${ep}` : sp.replace(/\s*[-–—]+\s*/g, '--')
  const simple: [string, string[]][] = [['volume', ['VL']], ['number', ['IS']], ['edition', ['ET']], ['address', ['CY']]]
  for (const [f, t] of simple) if (one(...t)) fields[f] = texEscape(one(...t))
  const publisher = one('PB')
  if (publisher) fields[bibtype === 'techreport' ? 'institution' : bibtype === 'phdthesis' ? 'school' : 'publisher'] = texEscape(publisher)
  const doi = one('DO').replace(/^(https?:\/\/(dx\.)?doi\.org\/|doi:\s*)/i, '')
  if (doi) fields.doi = doi
  const sn = one('SN')
  if (sn && /^[\d-]{10,17}X?$/i.test(sn.replace(/\s/g, '')) && bibtype === 'book') fields.isbn = sn
  const url = one('UR', 'L2')
  if (url) fields.url = url
  const accessed = one('Y2').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (accessed && url) {
    fields.urldate = `${accessed[1]}-${accessed[2].padStart(2, '0')}-${accessed[3].padStart(2, '0')}`
    fields.note = `Accessed ${humanDate(fields.urldate)}`
  }
  return { bibtype, fields }
}

// ---------- pasted text ----------

export type Pasted = { kind: 'bibtex' | 'ris' | 'list' | 'single'; items: string[] }

/** What the user pasted: BibTeX, RIS, several references (one per line), or one thing to look up. */
export function classifyPaste(text: string): Pasted {
  const t = text.trim()
  if (/^@\w+\s*\{/m.test(t) && /^\s*@/.test(t)) return { kind: 'bibtex', items: [t] }
  if (/^TY\s{1,2}-/m.test(t)) return { kind: 'ris', items: [t] }
  const lines = t
    .split(/\n+/)
    .map(l => l.replace(/^\s*(\[\d+\]|\d+[.)]|[•*-])\s+/, '').trim())
    .filter(l => l.length > 0)
  if (lines.length > 1 && lines.filter(l => l.length > 25).length > 1) return { kind: 'list', items: lines.filter(l => l.length > 10) }
  return { kind: 'single', items: [lines.join(' ')] }
}

/** How well a found title fits what was typed or pasted (0–1), to tell real matches from guesses. */
export function titleMatch(title: string, reference: string) {
  const words = (s: string) => plain(s).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w))
  const want = words(title)
  const typed = words(reference)
  if (!want.length || !typed.length) return 0
  const have = new Set(typed)
  const found = want.filter(w => have.has(w)).length / want.length
  if (typed.length > 12 || /\b(1[5-9]|20)\d\d\b/.test(reference)) return found
  // a typed title (not a whole reference): the found title should also cover what was typed
  const inTitle = new Set(want)
  return (found + typed.filter(w => inTitle.has(w)).length / typed.length) / 2
}
