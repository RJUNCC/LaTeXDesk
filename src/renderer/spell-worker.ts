// Spell-check worker: Overleaf's Hunspell (compiled to WebAssembly) with the en_US dictionary plus
// Overleaf's list of scientific terms. Adapted from overleaf/.../source-editor/hunspell/hunspell.worker.ts.
import Hunspell from '../overleaf/hunspell/hunspell.mjs'

type Msg =
  | { id: number; type: 'init'; learned: string[] }
  | { id: number; type: 'spell'; words: string[] }
  | { id: number; type: 'suggest'; word: string }
  | { id: number; type: 'add'; word: string }

type Checker = { spell(words: string[]): number[]; suggest(word: string): string[]; add(word: string): void }

let checker: Promise<Checker> | null = null

async function create(learned: string[]): Promise<Checker> {
  const base = new URL('./hunspell/', self.location.href)
  const hs = await Hunspell({ locateFile: (file: string) => new URL(file, base).toString() })
  const { cwrap, FS, MEMFS, stringToNewUTF8, _malloc, _free, getValue, UTF8ToString } = hs
  const createHs = cwrap('Hunspell_create', 'number', ['number', 'number'])
  const spell = cwrap('Hunspell_spell', 'number', ['number', 'number'])
  const suggest = cwrap('Hunspell_suggest', 'number', ['number', 'number', 'number'])
  const addDic = cwrap('Hunspell_add_dic', 'number', ['number', 'number'])
  const addWord = cwrap('Hunspell_add', 'number', ['number', 'number'])
  const freeList = cwrap('Hunspell_free_list', 'number', ['number', 'number', 'number'])

  const [dic, aff, science] = await Promise.all(
    ['en_US.dic', 'en_US.aff', 'en_US-science.txt'].map(f => fetch(new URL(f, base)).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`missing ${f}`)))))
  )
  FS.mkdir('/dict')
  FS.mount(MEMFS, {}, '/dict')
  FS.writeFile('/dict/index.dic', new Uint8Array(dic))
  FS.writeFile('/dict/index.aff', new Uint8Array(aff))
  const affPtr = stringToNewUTF8('/dict/index.aff')
  const dicPtr = stringToNewUTF8('/dict/index.dic')
  const handle = createHs(affPtr, dicPtr)

  // extra dictionary: scientific terms + the user's learned words (first line = approximate count)
  const extra = [...new TextDecoder().decode(science).split('\n').filter(Boolean), ...learned]
  FS.writeFile('/dict/extra.dic', new TextEncoder().encode([String(extra.length), ...extra].join('\n')))
  const extraPtr = stringToNewUTF8('/dict/extra.dic')
  addDic(handle, extraPtr)
  _free(extraPtr)

  return {
    spell(words) {
      const bad: number[] = []
      words.forEach((w, i) => {
        const p = stringToNewUTF8(w)
        if (spell(handle, p) === 0) bad.push(i)
        _free(p)
      })
      return bad
    },
    suggest(word) {
      const listPtr = _malloc(4)
      const p = stringToNewUTF8(word)
      const n = suggest(handle, listPtr, p)
      _free(p)
      const arr = getValue(listPtr, '*')
      const out: string[] = []
      for (let i = 0; i < n; i++) out.push(UTF8ToString(getValue(arr + i * 4, '*')))
      freeList(handle, listPtr, n)
      _free(listPtr)
      return out.slice(0, 8)
    },
    add(word) {
      const p = stringToNewUTF8(word)
      addWord(handle, p)
      _free(p)
    },
  }
}

self.onmessage = async (ev: MessageEvent<Msg>) => {
  const msg = ev.data
  try {
    if (msg.type === 'init') {
      checker = create(msg.learned)
      await checker
      return postMessage({ id: msg.id, ok: true })
    }
    const c = await checker!
    if (msg.type === 'spell') postMessage({ id: msg.id, ok: true, result: c.spell(msg.words) })
    else if (msg.type === 'suggest') postMessage({ id: msg.id, ok: true, result: c.suggest(msg.word) })
    else if (msg.type === 'add') (c.add(msg.word), postMessage({ id: msg.id, ok: true }))
  } catch (e) {
    postMessage({ id: msg.id, ok: false, error: String((e as Error).message || e) })
  }
}
