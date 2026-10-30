import {
  CharCategory,
  EditorState,
  SelectionRange,
  Text,
  codePointAt,
  codePointSize,
} from '@codemirror/state'
import { CloseBracketConfig } from '@codemirror/autocomplete'

// LaTeXDesk: Overleaf exports these from a patched @codemirror/autocomplete;
// they are inlined here from upstream so the stock package works.
const nextChar = (doc: Text, pos: number) => {
  const next = doc.sliceString(pos, pos + 2)
  return next.slice(0, codePointSize(codePointAt(next, 0)))
}
const prevChar = (doc: Text, pos: number) => {
  const prev = doc.sliceString(pos - 2, pos)
  return codePointSize(codePointAt(prev, 0)) === prev.length ? prev : prev.slice(1)
}

// LaTeXDesk: buildInsert is only honoured by Overleaf's patched autocomplete; stock CM ignores it
export const closeBracketConfig = {
  brackets: ['$', '$$', '[', '{', '('],
  buildInsert(
    state: EditorState,
    range: SelectionRange,
    open: string,
    close: string
  ): string {
    switch (open) {
      // close for $ or $$
      case '$': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing dollar to \\$
          if (preprev === '\\') {
            return open + '$'
          }
          // don't auto-close \$
          return open
        }

        const next = nextChar(state.doc, range.head)
        if (next === '\\') {
          // avoid auto-closing $ before a TeX command
          const pos = range.head + prev.length
          const postnext = nextChar(state.doc, pos)

          if (state.charCategorizer(pos)(postnext) !== CharCategory.Word) {
            return open + '$'
          }

          // don't auto-close $\command
          return open
        }

        // avoid creating an odd number of dollar signs
        const count = countSurroundingCharacters(state.doc, range.from, open)
        if (count % 2 !== 0) {
          return open
        }
        return open + close
      }

      // close for [ or \[
      case '[': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing bracket to \\[
          if (preprev === '\\') {
            return open + ']'
          }
          return open + '\\' + close
        }
        return open + close
      }

      // only close for \(
      case '(': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // don't auto-close \\(
          if (preprev === '\\') {
            return open
          }
          return open + '\\' + close
        }
        return open
      }

      // only close for {
      case '{': {
        const prev = prevChar(state.doc, range.head)
        if (prev === '\\') {
          const preprev = prevChar(state.doc, range.head - prev.length)
          // add an unprefixed closing bracket to \\{
          if (preprev === '\\') {
            return open + '}'
          }
          // don't auto-close \{
          return open
        }
        return open + close
      }

      default:
        return open + close
    }
  },
} as CloseBracketConfig

function countSurroundingCharacters(doc: Text, pos: number, insert: string) {
  let count = 0
  // count backwards
  let to = pos
  do {
    const char = doc.sliceString(to - insert.length, to)
    if (char !== insert) {
      break
    }
    count++
    to--
  } while (to > 1)
  // count forwards
  let from = pos
  do {
    const char = doc.sliceString(from, from + insert.length)
    if (char !== insert) {
      break
    }
    count++
    from++
  } while (from < doc.length)
  return count
}
