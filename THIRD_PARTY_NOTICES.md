# Third-party notices

LaTeXDesk is free software under the **GNU Affero General Public License v3.0** (see `LICENSE`), because it
includes code from Overleaf. It also bundles or uses the following.

## Included in the app

| Component | License | Used for |
|---|---|---|
| [Overleaf](https://github.com/overleaf/overleaf) editor components (`src/overleaf/`) | AGPL-3.0 | LaTeX grammar and language support, the visual editor, log parser, spell-check engine and science word list |
| [Hunspell](https://hunspell.github.io/) (WebAssembly build from Overleaf) | MPL-1.1 / GPL-2.0 / LGPL-2.1 | Spell checking |
| [dictionary-en](https://github.com/wooorm/dictionaries) | MIT and BSD (SCOWL) | English dictionary |
| [CodeMirror 6](https://codemirror.net/) and [Lezer](https://lezer.codemirror.net/) | MIT | The editor |
| [PDF.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 | PDF preview, PDF figures, reading Zotero PDFs |
| [KaTeX](https://katex.org/) | MIT | Rendering maths in previews and the visual editor |
| [math.js](https://mathjs.org/) | Apache-2.0 | Checking the algebra in proofs |
| [jsdiff](https://github.com/kpdecker/jsdiff) | BSD-3-Clause | Reviewing proposed changes |
| [fflate](https://github.com/101arrowz/fflate) | MIT | Export for submission (zip) |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) | Apache-2.0 | Optional Claude API access |
| [Electron](https://www.electronjs.org/) | MIT | The desktop app shell |

## Downloaded or used separately (not included)

| Component | License | Notes |
|---|---|---|
| [LanguageTool](https://languagetool.org/) | LGPL-2.1 | Downloaded on request for grammar checking, runs locally |
| A TeX distribution, e.g. [MiKTeX](https://miktex.org/) | Various free licenses | Installed by the user; LaTeXDesk runs `pdflatex`, `bibtex`, `biber` |
| [Ollama](https://ollama.com/) and its models | MIT (Ollama); per-model licenses | Optional local AI |
| [Zotero](https://www.zotero.org/) and [Better BibTeX](https://retorque.re/zotero-better-bibtex/) | AGPL-3.0 / MIT | Optional reference library, used over its local API |

"Overleaf" is a trademark of Overleaf (Digital Science UK Ltd). LaTeXDesk is not affiliated with or endorsed by
Overleaf; the name and logo are not used.
