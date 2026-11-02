// "How LaTeXDesk works": topic pages, and a guided tour that spotlights each part of the window in turn.

export type TourStep = { id: string; selector: string; title: string; text: string; panel?: string }

export const TOUR: TourStep[] = [
  { id: 'files', selector: '#sidebar', title: 'Your files and outline', text: 'Every file in the project folder. Click one to open it; the green dot marks the main document (the one that gets compiled). The outline underneath lists your sections; click one to jump there.' },
  { id: 'mode', selector: '#mode-switch', title: 'Code or Visual', text: 'Code shows the LaTeX source. Visual shows it formatted, like a word processor, with headings, bold, maths and figures. It’s the same file either way (Ctrl+Shift+E switches).' },
  { id: 'toolbar', selector: '#format-bar', title: 'The formatting toolbar', text: 'Headings, bold and italic, lists, maths, tables, figures, links, citations and more. Select text and click, or click to insert. Any package a button needs is added for you.' },
  { id: 'editor', selector: '#editor', title: 'The editor', text: 'Type here. Grey suggestions are AI autocomplete (Tab accepts). Hover over maths to preview it. Red underlines are spelling; blue and purple are grammar and style; right-click a word for suggestions.' },
  { id: 'compile', selector: '#compile-btn', title: 'Compile to PDF', text: 'Recompile (Ctrl+Enter) turns your document into a PDF. Tick Auto to recompile a moment after you stop typing. Your work is saved automatically.' },
  { id: 'pdf', selector: '#pdf-pane', title: 'The PDF preview', text: 'Your document as it will look. Double-click anywhere in the PDF to jump to that spot in the source; Ctrl+Alt+J jumps the other way.', panel: 'pdf' },
  { id: 'logs', selector: '#logs-btn', title: 'Errors and warnings', text: 'If something goes wrong, the count appears here and the line is marked in the editor. Open Logs to see what happened; each error has an Explain & fix button that asks the AI.' },
  { id: 'suggest', selector: '#suggest-btn', title: 'Comments and suggestions', text: 'Select text and click 💬 to leave a comment (Ctrl+Alt+M). Turn on Suggest and your edits show as suggestions someone can accept or reject, like Track Changes in Word.' },
  { id: 'comments', selector: '[data-panel="comments"]', title: 'Comments tab', text: 'Every comment and suggestion in the file, in reading order: reply, resolve, accept or reject. They are saved with the project, so whoever you share the folder with sees them too.', panel: 'comments' },
  { id: 'ai', selector: '[data-panel="ai"]', title: 'AI tab', text: 'Ask questions about your document, review it, tighten a paragraph or summarise. Any change the AI suggests is shown first, for you to approve.', panel: 'ai' },
  { id: 'review', selector: '[data-panel="review"]', title: 'Review tab', text: 'Analyze checks grammar, how the writing flows, whether claims match your sources, whether the argument holds together, and how balanced it is. Accessibility checks the PDF works with screen readers.', panel: 'review' },
  { id: 'proof', selector: '[data-panel="proof"]', title: 'Proof tab', text: 'Build a proof step by step from a theorem, or check one you wrote. The algebra is checked exactly, and the AI checks whether each step follows.', panel: 'proof' },
  { id: 'tasks', selector: '[data-panel="tasks"]', title: 'Tasks', text: 'A to-do list for the document, including any % TODO comments you write. The AI can carry a task out for you, as a change you review.', panel: 'tasks' },
  { id: 'refs', selector: '[data-panel="references"]', title: 'References', text: 'Every source this document cites: missing ones, unused ones, and where each is cited.', panel: 'references' },
  { id: 'library', selector: '[data-panel="library"]', title: 'Your Zotero library', text: 'With Zotero open, search your library and cite in one click, or ask questions answered from your PDFs.', panel: 'library' },
  { id: 'research', selector: '[data-panel="research"]', title: 'Research', text: 'Turn a DOI, arXiv ID or web address into a citation, search for papers, or paste a screenshot of an equation to get its LaTeX.', panel: 'research' },
  { id: 'history', selector: '[data-panel="history"]', title: 'History', text: 'A snapshot is kept every time the document compiles. Compare versions side by side and restore one if you need to.', panel: 'history' },
  { id: 'settings', selector: '#ai-settings-btn', title: 'Settings', text: 'Your name (for comments), the TeX engine, automatic updates, and which AI model each feature uses: free local models through Ollama, or Claude with your own key. Ctrl+, also opens it.' },
  { id: 'learn', selector: '#learn-btn', title: 'Learn and Help', text: 'Come back here any time for the lessons and these guides. The Help menu has Getting Started (what your computer still needs), Import Document, and Report a Bug.' },
]

export type Topic = { id: string; title: string; html: string; tour?: string[] }

export const TOPICS: Topic[] = [
  {
    id: 'projects',
    title: 'Projects and files',
    tour: ['files'],
    html: `<p>A <b>project</b> is a folder on your computer. Open one with <b>Open</b> (Ctrl+O), start one from a <b>Template</b>, or <b>import</b> a Word or Google Docs file (File → Import Document).</p>
      <p>The <b>main document</b> is the file with <code>\\documentclass</code>; that's the one that gets compiled. Bigger documents can be split into several files joined with <code>\\input{chapter1}</code>. To change which file is main, use Build → Set Current File as Main Document.</p>
      <p>Everything saves automatically. LaTeXDesk keeps its own working files in a hidden <code>.texdesk</code> folder inside the project.</p>`,
  },
  {
    id: 'modes',
    title: 'Code and Visual mode',
    tour: ['mode', 'toolbar', 'editor'],
    html: `<p><b>Visual</b> mode shows your document formatted: headings look like headings, maths is rendered, figures and tables appear. It's the easiest way to write if you don't know LaTeX. Use the toolbar for formatting, and paste from Word or the web.</p>
      <p><b>Code</b> mode shows the LaTeX itself, with autocomplete, maths previews and every option available.</p>
      <p>It's one file either way, so switch whenever you like with the <b>Code | Visual</b> buttons or Ctrl+Shift+E. Click a formatted element in Visual mode to edit the LaTeX underneath.</p>`,
  },
  {
    id: 'compiling',
    title: 'Compiling and the PDF',
    tour: ['compile', 'pdf', 'logs'],
    html: `<p><b>Compiling</b> turns your LaTeX into a PDF. It uses MiKTeX or TeX Live if you have one, or LaTeXDesk's own <b>built-in engine</b> (about 20 MB, set up with one click the first time you compile). Help → Getting Started shows which.</p>
      <p>Click <b>Recompile</b> or press Ctrl+Enter, or tick <b>Auto</b>. The first compile of a new document can take a little longer while the packages it needs are downloaded.</p>
      <p>If there's an error, the line is marked in red and <b>Logs</b> explains it. Click <b>Explain &amp; fix</b> for a plain-language explanation and a suggested fix. Often the problem is a missing <code>}</code> or a special character that needs a backslash (<code>\\%</code>, <code>\\&amp;</code>, <code>\\_</code>).</p>`,
  },
  {
    id: 'import',
    title: 'Templates, importing and exporting',
    html: `<p><b>Templates</b> (Ctrl+Shift+N) start a new document: article, report, slides, homework, lab report, letter or CV, papers for <b>IEEE, ACM, APA, Springer and Elsevier</b>, and a full <b>thesis</b> with chapters in their own files.</p>
      <p><b>Import Document</b> (File menu, Ctrl+Shift+I) turns a Word file into LaTeX, keeping headings, formatting, lists, tables, images, footnotes and equations. Google Docs works too: use File → Download → Microsoft Word first. LibreOffice (.odt), Markdown and HTML files can be imported the same way.</p>
      <p><b>Export to Word</b> (File menu) makes a .docx for people who don't use LaTeX, with equations they can edit, and your comments and suggestions as Word comments and tracked changes.</p>
      <p><b>Export for Submission</b> (File menu) makes a single zip with only the files your document uses, ready for a journal or a teacher. It's test-compiled first.</p>`,
  },
  {
    id: 'collaborate',
    title: 'Comments, suggestions and sharing',
    tour: ['suggest', 'comments'],
    html: `<p><b>Comment</b> on any text: select it and click 💬 (or Ctrl+Alt+M). Others can reply, and resolve the comment when it's dealt with.</p>
      <p><b>Suggest</b> changes instead of making them: turn on Suggest above the editor and edit as usual. Added text is highlighted and deleted text is struck through, with your name on it, until the author accepts or rejects it (in the Comments tab, or by hovering over it).</p>
      <p>Comments and suggestions are saved in the project's hidden <code>.texdesk</code> folder. To work with someone, share the whole project folder (zip it, or keep it in OneDrive or Dropbox). Set your name in Settings so they know who wrote what.</p>
      <p>Working with someone who uses Word? <b>File → Export to Word</b> includes them as Word comments and tracked changes.</p>`,
  },
  {
    id: 'ai',
    title: 'AI features and setup',
    tour: ['ai', 'settings'],
    html: `<p>LaTeXDesk's AI runs <b>on your computer</b> by default, through <a href="https://ollama.com/download" target="_blank">Ollama</a>. It's free and private. Help → Getting Started can download the recommended models (about 20 GB). You can instead use Claude with your own API key, chosen per feature in Settings.</p>
      <ul><li><b>Autocomplete:</b> grey suggestions as you type; Tab accepts, Esc dismisses.</li>
      <li><b>Explain &amp; fix</b> on compile errors.</li>
      <li><b>AI tab:</b> questions, reviews, tightening and summaries.</li>
      <li><b>Tasks</b> the AI can carry out.</li>
      <li><b>Screenshot → LaTeX</b> in the Research tab.</li></ul>
      <p>The AI never changes your document on its own: you see every change first and approve it.</p>`,
  },
  {
    id: 'review',
    title: 'The Review tab',
    tour: ['review'],
    html: `<p>Grammar and style are underlined as you type (once grammar checking is set up in Getting Started). <b>Analyze</b> goes further:</p>
      <ul><li><b>Writing:</b> sentences that are unclear, don't follow on, or repeat.</li>
      <li><b>Fact check:</b> each claim is compared with the papers it cites, your Zotero library and free web sources.</li>
      <li><b>Argument:</b> contradictions, circular reasoning, numbers that don't match, and conclusions that don't follow.</li>
      <li><b>Bias:</b> how balanced each section is.</li></ul>
      <p>The first Analyze takes a minute or two; after that only changed paragraphs are re-checked.</p>
      <p><b>Accessibility</b> (no AI needed) checks the PDF works for everyone: pictures have descriptions for screen readers, the PDF has a title and language, text colours have enough contrast, headings don't skip levels, and link text says where it goes. Most problems have a one-click fix.</p>`,
  },
  {
    id: 'proof',
    title: 'The Proof tab',
    tour: ['proof'],
    html: `<p>Write a theorem and press <b>Build steps</b>: the AI writes the proof as numbered steps, each with its reason. Or press <b>Skeleton</b> for an empty outline (direct, contradiction, induction…) to fill in yourself.</p>
      <p><b>Check steps</b> goes through them in order. Every equation is checked exactly, and a wrong one gets a counterexample. The AI judges whether each step follows from the earlier ones.</p>
      <p>Put the cursor in a proof you've written and press <b>Check my proof</b> to have it checked the same way.</p>`,
  },
  {
    id: 'references',
    title: 'References, Zotero and research',
    tour: ['refs', 'library', 'research'],
    html: `<p>Citations come from a <b>.bib</b> file. The easiest ways to fill it:</p>
      <ul><li><b>Research tab:</b> paste a DOI, arXiv ID, ISBN or link and click Cite, or search for papers.</li>
      <li><b>Zotero:</b> with Zotero and its Better BibTeX plugin, cite from your library in the <b>Library</b> tab, or type <code>\\cite{</code> and pick a paper.</li></ul>
      <p>The <b>Refs</b> tab shows every source the document cites, and flags missing or unused ones.</p>`,
  },
  {
    id: 'history',
    title: 'Tasks and History',
    tour: ['tasks', 'history'],
    html: `<p><b>Tasks</b> is a to-do list for the document. It also picks up any <code>% TODO: …</code> comment you write. Click <b>Run with AI</b> to have a task done as a change you approve.</p>
      <p><b>History</b> keeps a snapshot each time the document compiles cleanly, plus any you save yourself. Compare any snapshot with now, and restore a file or the whole project.</p>`,
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    html: `<table class="learn-keys">
      <tr><td>Ctrl+Enter</td><td>Compile</td></tr><tr><td>Ctrl+S</td><td>Save (and compile when Auto is on)</td></tr>
      <tr><td>Ctrl+B / Ctrl+I</td><td>Bold / italic</td></tr><tr><td>Ctrl+Shift+E</td><td>Switch Code / Visual</td></tr>
      <tr><td>Ctrl+/</td><td>Comment out lines</td></tr><tr><td>Ctrl+F</td><td>Find and replace</td></tr>
      <tr><td>Ctrl+N</td><td>New file</td></tr><tr><td>Ctrl+Shift+N</td><td>New from template</td></tr>
      <tr><td>Ctrl+Shift+I</td><td>Import a document</td></tr><tr><td>Ctrl+O</td><td>Open a project</td></tr>
      <tr><td>Ctrl+Alt+J</td><td>Jump from the source to the PDF</td></tr><tr><td>Ctrl+L</td><td>Logs</td></tr>
      <tr><td>Ctrl+,</td><td>Settings</td></tr><tr><td>Tab / Esc</td><td>Accept / dismiss an AI suggestion</td></tr></table>`,
  },
]

/**
 * Run tour steps: dim the window except the highlighted element, with a card explaining it.
 * Steps whose element isn't on screen (e.g. Code | Visual when no .tex file is open) are skipped.
 */
export function runTour(ids: string[] | null, showPanel: (name: string) => void, onEnd: () => void = () => {}) {
  const steps = (ids ? TOUR.filter(s => ids.includes(s.id)) : TOUR).filter(s => {
    const el = document.querySelector<HTMLElement>(s.selector)
    return el && !el.hidden && el.getClientRects().length > 0
  })
  if (!steps.length) return onEnd()
  const shade = document.createElement('div')
  shade.className = 'tour-spot'
  const card = document.createElement('div')
  card.className = 'tour-card'
  card.setAttribute('role', 'dialog')
  document.body.append(shade, card)
  let i = 0
  const end = () => {
    shade.remove()
    card.remove()
    window.removeEventListener('resize', place)
    document.removeEventListener('keydown', keys, true)
    onEnd()
  }
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'Escape') (e.preventDefault(), end())
    else if (e.key === 'ArrowRight' || e.key === 'Enter') (e.preventDefault(), go(i + 1))
    else if (e.key === 'ArrowLeft') (e.preventDefault(), go(i - 1))
  }
  function place() {
    const el = document.querySelector<HTMLElement>(steps[i].selector)
    if (!el) return
    const r = el.getBoundingClientRect()
    const pad = 6
    Object.assign(shade.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` })
    // the card goes beside the element where there's room: below, above, left or right
    const cw = card.offsetWidth
    const ch = card.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = Math.min(Math.max(12, r.left), vw - cw - 12)
    let top = r.bottom + 14
    if (top + ch > vh - 12) top = r.top - ch - 14
    if (top < 12) {
      top = Math.min(Math.max(12, r.top), vh - ch - 12)
      left = r.right + 14 + cw < vw ? r.right + 14 : Math.max(12, r.left - cw - 14)
    }
    Object.assign(card.style, { left: `${left}px`, top: `${top}px` })
  }
  function go(n: number) {
    if (n < 0) return
    if (n >= steps.length) return end()
    i = n
    const s = steps[i]
    if (s.panel) showPanel(s.panel)
    card.innerHTML = `
      <div class="tour-count">${i + 1} of ${steps.length}</div>
      <h4>${s.title}</h4>
      <p>${s.text}</p>
      <div class="tour-actions">
        <button type="button" class="tour-skip">${i === steps.length - 1 ? 'Close' : 'Skip tour'}</button>
        <span class="spacer"></span>
        ${i > 0 ? '<button type="button" class="tour-back">Back</button>' : ''}
        <button type="button" class="primary tour-next">${i === steps.length - 1 ? 'Done' : 'Next'}</button>
      </div>`
    card.querySelector<HTMLButtonElement>('.tour-skip')!.onclick = end
    card.querySelector<HTMLButtonElement>('.tour-back')?.addEventListener('click', () => go(i - 1))
    card.querySelector<HTMLButtonElement>('.tour-next')!.onclick = () => go(i + 1)
    requestAnimationFrame(place)
    card.querySelector<HTMLButtonElement>('.tour-next')!.focus()
  }
  window.addEventListener('resize', place)
  document.addEventListener('keydown', keys, true)
  go(0)
}
