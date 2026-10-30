// The editor's look (syntax colours and dark theme), shared by the main editor and the Learn practice editor.
import { HighlightStyle } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

// Colours loosely follow Overleaf's dark editor theme
export const highlightStyle = HighlightStyle.define([
  { tag: t.tagName, color: '#7cb7ff' },
  { tag: t.keyword, color: '#c792ea' },
  { tag: t.literal, color: '#7cb7ff' },
  { tag: t.attributeValue, color: '#f0b46e' },
  { tag: t.typeName, color: '#f0b46e' },
  { tag: t.string, color: '#8fd18f' },
  { tag: t.number, color: '#f78c6c' },
  { tag: t.comment, color: '#7d8590', fontStyle: 'italic' },
  { tag: [t.brace, t.squareBracket], color: '#d4b106' },
  { tag: t.link, color: '#7cb7ff', textDecoration: 'underline' },
  { tag: t.monospace, fontFamily: 'inherit' },
  { tag: t.strong, fontWeight: 'bold' },
])

export const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
    // no ligatures: fonts like Cascadia Code would show TikZ's -> and >= as → and ≥
    '.cm-content': { caretColor: '#fff', fontFamily: 'var(--mono)', fontVariantLigatures: 'none' },
    '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.55' },
    '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: '#5c6370', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff0d', color: '#abb2bf' },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#fff' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#3a4a6b !important',
    },
    '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--border)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  },
  { dark: true }
)
