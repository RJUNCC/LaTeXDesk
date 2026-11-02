# LaTeXDesk

A desktop editor for papers, reports, theses and maths, for Windows. Write in **Visual** mode like a word
processor, or in **Code** mode as LaTeX, and get a PDF. Everything runs on your computer: no account, no
server, and the AI features work offline with free local models.

LaTeXDesk is built on [Overleaf](https://github.com/overleaf/overleaf)'s open-source editor components and is
free software (AGPL-3.0).

## Install

1. Download **`LaTeXDesk-Setup-x.y.z.exe`** from the [Releases](https://github.com/RJUNCC/LaTeXDesk/releases) page and run it.
   Windows may say *"Windows protected your PC"* because the app isn't code-signed: click **More info → Run anyway**.
2. Open LaTeXDesk and compile. If your computer has no TeX yet, LaTeXDesk offers its **built-in engine**
   ([Tectonic](https://tectonic-typesetting.github.io/), about 20 MB, one click). It downloads the LaTeX packages a
   document needs the first time they're used, so the first compile needs the internet.
   Prefer a full distribution? Install **[MiKTeX](https://miktex.org/download)** and choose **"Install missing packages
   on-the-fly: Yes"**. LaTeXDesk uses it automatically (Settings → TeX engine to choose).
3. The **Getting Started** screen (also under Help) shows what's set up and links to the rest.

LaTeXDesk **updates itself**: when a new version is out, a notice offers to download it, and it installs when you
close the app. Turn this off in Settings, or use Help → Check for Updates.

Optional extras, each shown in Getting Started:

| Extra | What it adds | Get it |
|---|---|---|
| Grammar checking | Grammar and style underlines as you type | Install [Java (Temurin)](https://adoptium.net/), then click *Install LanguageTool* in Getting Started |
| Local AI | Autocomplete, review, writing analysis, proofs, screenshot → LaTeX | Install [Ollama](https://ollama.com/download), then *Download models* (about 20 GB; a graphics card with 8 GB+ helps). Or add a Claude API key in Settings |
| Zotero | Cite from your library, fact-check against your PDFs | [Zotero](https://www.zotero.org/download/) with the [Better BibTeX](https://retorque.re/zotero-better-bibtex/installation/) plugin |

To keep it on the taskbar: right-click LaTeXDesk in the Start menu → **Pin to taskbar**.

## New to LaTeX?

Click **Learn** in the top bar (or press F1):
- **Learn LaTeX:** 15 short hands-on lessons, covering:
  - your first document, paragraphs and special characters;
  - sections, emphasis, lists;
  - maths, equations;
  - tables, figures;
  - citations and citation styles, packages;
  - long documents (several files, cross-references, contents);
  - slides (Beamer) and diagrams (TikZ).

  Each has a practice editor and a live PDF. Press **Check** to compile it and tick off the goals, with a hint
  for anything not done yet. Progress is saved, and the practice files never touch your projects.
- **How LaTeXDesk works:** short guides to every part of the app. **Show me** runs a guided tour that
  highlights each control and explains it.

Already have a document? **File → Import Document** (Ctrl+Shift+I) turns it into LaTeX:
- **Word (.docx).** For **Google Docs**, use File → Download → Microsoft Word first.
- **LibreOffice (.odt), Markdown and HTML.**
- **What's kept:** headings, bold and italic, lists, tables, links, footnotes, images, and Word equations
  (converted to LaTeX maths). Page layout, comments and tracked changes aren't carried over.

## Writing

- **Visual or Code:** switch with the **Code | Visual** buttons above the editor (Ctrl+Shift+E). Visual shows
  headings, bold, lists, equations, figures and tables the way they'll look. It's the same file either way, so
  you can switch freely and share files with people who use LaTeX.
- **Formatting toolbar:** headings, bold/italic/underline, colours and sizes, lists, alignment, maths, tables
  (grid picker), figures, links, footnotes, citations and references. Any package these need is added for you.
- **Paste from Word, Google Docs or the web:** in Visual mode, formatting (headings, bold, lists, links, tables)
  is converted to LaTeX.
- **Templates** (File → New from Template): article, report, slides (Beamer), homework, lab report, letter, CV;
  papers for **IEEE, ACM, APA 7, Springer LNCS and Elsevier**; and a **thesis** with chapters in their own files.
- **PDF preview** with zoom, and jump between the source and the PDF (Ctrl+Alt+J, or double-click the PDF).
- **Spell check** (offline, with a scientific word list) and **equation preview** as you type.
- **History:** a snapshot after every successful compile, with side-by-side comparison and restore.
- **Tables and plots from data:** paste CSV or Excel cells to make a table or a chart.
- **Markov chain builder:** draw a chain; get a TikZ diagram, the transition matrix and, for absorbing chains,
  exact absorption probabilities and expected steps.
- **Export to Word** (File menu): a .docx with headings, lists, tables, pictures (PDF figures too), footnotes,
  numbered references and **editable Word equations**, for people who don't use LaTeX.
- **Export for submission:** one zip with `\input`s flattened, comments removed and only the files used,
  test-compiled first.

## Working with others

- **Comments:** select text and click 💬 (Ctrl+Alt+M). Reply, resolve, and see them all in the **Comments** tab.
- **Suggest changes** (track changes): turn on **Suggest** above the editor, and your edits show as suggestions
  (insertions highlighted, deletions struck through) for the author to accept or reject.
- They're saved in the project's hidden `.texdesk` folder, so sharing the folder (zip, OneDrive, Dropbox) shares
  them too. Set your name in Settings.
- **Export to Word** includes them as Word comments and tracked changes, for reviewers who use Word.

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
  - a **bias matrix**;
  - **accessibility** (no AI needed): picture descriptions for screen readers, the PDF's title and language,
    colour contrast, heading order and link text, mostly with one-click fixes.
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
- choosing a cloud AI provider;
- the built-in TeX engine downloading a package a document needs (only package names are sent);
- checking GitHub for a new version of LaTeXDesk (can be turned off in Settings).

## Feedback

Feedback is very welcome:
- **Something broken?** [Report a bug](https://github.com/RJUNCC/LaTeXDesk/issues/new?template=bug_report.yml).
- **Have an idea?** [Suggest a feature](https://github.com/RJUNCC/LaTeXDesk/issues/new?template=feature_request.yml).
- **Questions, tips, or just want to say what you think?** Join the [Discussions](https://github.com/RJUNCC/LaTeXDesk/discussions).

In the app, the same links are under **Help → Report a Bug / Suggest a Feature**, and they fill in your version
for you. You'll need a free GitHub account to post.

## Build from source

Needs [Node.js](https://nodejs.org/) 20+ and Windows.

```
npm install
npm start          # build and run
npm run dist       # installer in release/
```

**Publishing a release** (so installed copies update themselves): bump `version` in `package.json`, run
`npm run dist`, then on GitHub draft a release tagged `vX.Y.Z` and attach all three files from `release/`:
`LaTeXDesk-Setup-X.Y.Z.exe`, its `.blockmap` and `latest.yml`. (Or set a `GH_TOKEN` and run `npm run release`,
which uploads them to a draft release for you.)

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
