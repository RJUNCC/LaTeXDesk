# LaTeXDesk

A desktop editor for papers, reports, theses and maths, for Windows. Write in **Visual** mode like a word
processor, or in **Code** mode as LaTeX, and get a PDF. Everything runs on your computer: no account, no
server, and the AI features work offline with free local models.

LaTeXDesk is built on [Overleaf](https://github.com/overleaf/overleaf)'s open-source editor components and is
free software (AGPL-3.0).

## Install

1. Download **`LaTeXDesk Setup x.y.z.exe`** from the [Releases](https://github.com/RJUNCC/LaTeXDesk/releases) page and run it.
   Windows may say *"Windows protected your PC"* because the app isn't code-signed: click **More info → Run anyway**.
2. Install **[MiKTeX](https://miktex.org/download)** (free). It turns your document into a PDF. During setup,
   choose **"Install missing packages on-the-fly: Yes"**.
3. Open LaTeXDesk. The **Getting Started** screen (also under Help) shows what's set up and links to the rest.

Optional extras, each shown in Getting Started:

| Extra | What it adds | Get it |
|---|---|---|
| Grammar checking | Grammar and style underlines as you type | Install [Java (Temurin)](https://adoptium.net/), then click *Install LanguageTool* in Getting Started |
| Local AI | Autocomplete, review, writing analysis, proofs, screenshot → LaTeX | Install [Ollama](https://ollama.com/download), then *Download models* (about 20 GB; a graphics card with 8 GB+ helps). Or add a Claude API key in Settings |
| Zotero | Cite from your library, fact-check against your PDFs | [Zotero](https://www.zotero.org/download/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/installation/) plugin |

To keep it on the taskbar: right-click LaTeXDesk in the Start menu → **Pin to taskbar**.

## Writing

- **Visual or Code:** switch with the **Code | Visual** buttons above the editor (Ctrl+Shift+E). Visual shows
  headings, bold, lists, equations, figures and tables the way they'll look. It's the same file either way, so
  you can switch freely and share files with people who use LaTeX.
- **Formatting toolbar:** headings, bold/italic/underline, colours and sizes, lists, alignment, maths, tables
  (grid picker), figures, links, footnotes, citations and references. Any package these need is added for you.
- **Paste from Word, Google Docs or the web:** in Visual mode, formatting (headings, bold, lists, links, tables)
  is converted to LaTeX.
- **Templates** (File → New from Template): article, report/thesis, slides (Beamer), homework, lab report, letter, CV.
- **PDF preview** with zoom, and jump between the source and the PDF (Ctrl+Alt+J, or double-click the PDF).
- **Spell check** (offline, with a scientific word list) and **equation preview** as you type.
- **History:** a snapshot after every successful compile, with side-by-side comparison and restore.
- **Tables and plots from data:** paste CSV or Excel cells to make a table or a chart.
- **Markov chain builder:** draw a chain; get a TikZ diagram, the transition matrix and, for absorbing chains,
  exact absorption probabilities and expected steps.
- **Export for submission:** one zip with `\input`s flattened, comments removed and only the files used,
  test-compiled first.

## AI (local by default, free)

Each AI feature can use a local Ollama model (free, private) or, if you choose, Claude or any
OpenAI-compatible server. Choose per feature in **Settings** (⚙ or Ctrl+,). Every change the AI proposes is
shown as a diff for you to approve.

- **Autocomplete** (Tab accepts), **Explain & fix** on compile errors, an **AI tab** for questions and reviews,
  and **Tasks** the AI can carry out.
- **Review tab:**
  - live grammar;
  - flow and clarity;
  - **fact check** against the papers you cite and your Zotero library;
  - **argument check**: contradictions, circular reasoning, number mismatches, overclaiming, conclusions that
    don't follow;
  - a **bias matrix**.
- **Proof tab:**
  - turns a theorem into ordered proof steps;
  - **checks proofs step by step**: algebra is verified exactly by maths (with counterexamples), and logic is
    reviewed by AI;
  - inserts the proof into your document.
- **Research tab:**
  - a citation creator (DOI, arXiv, ISBN, URL → BibTeX);
  - paper search;
  - **screenshot → LaTeX**: paste an image of an equation or table.

## Zotero

With Zotero running and Better BibTeX installed:
- **Citing and syncing:** cite from your library, with `\cite{` autocomplete; keep the project's `.bib` in sync;
  save new papers to Zotero.
- **References tab:** shows every reference in the project, with missing and unused ones.
- **Ask my library:** answers questions from your PDFs, with citations.

Zotero has no limit on how many papers you keep. Only its free *cloud file storage* is capped (300 MB). To keep
unlimited PDFs for free, turn off "Sync attachment files" in Zotero's Sync settings and keep the data folder on
a large drive. The Library tab shows your storage use.

## Privacy

Your documents stay on your computer. Nothing is sent anywhere unless you use a feature that needs the internet:
- paper search or the citation creator;
- fact-checking an uncited claim against free web sources (only the claim text is sent);
- choosing a cloud AI provider.

## Build from source

Needs [Node.js](https://nodejs.org/) 20+ and Windows.

```
npm install
npm start          # build and run
npm run dist       # installer in release/
```

The code is organised like this:
- `main.js`: the Electron main process (compiling, files, AI providers, Zotero, LanguageTool).
- `src/renderer/`: the interface.
- `src/overleaf/`: code from Overleaf. The visual editor is in `src/overleaf/ol/`, which mirrors Overleaf's own
  folder layout. Changes are marked with `LaTeXDesk:` comments; for example, KaTeX replaces MathJax, and plain
  DOM replaces their React table and figure editors.

## License

GNU Affero General Public License v3.0: see [LICENSE](LICENSE). You may use, share and modify LaTeXDesk. If
you distribute it, you must make the source code available under the same license. Third-party components are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

LaTeXDesk is not affiliated with Overleaf. "Overleaf" is their trademark.
