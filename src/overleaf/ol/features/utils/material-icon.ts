// LaTeXDesk: Overleaf uses the Material Symbols icon font; plain symbols are used instead.
const SYMBOLS: Record<string, string> = { edit: '✎', expand_more: '▾', expand_less: '▴', error: '⚠', warning: '⚠', unfold_more: '↕', unfold_less: '↕' }

export function materialIcon(type: string) {
  const icon = document.createElement('span')
  icon.className = 'material-symbols'
  icon.textContent = SYMBOLS[type] ?? '•'
  icon.ariaHidden = 'true'
  icon.translate = false
  return icon
}
