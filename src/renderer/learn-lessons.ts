// The LaTeX lessons in the Learn view: a short explanation, a practice document, goals that are checked
// automatically (every lesson also has to compile without errors), a hint per goal and a model solution.

export type Goal = { text: string; hint: string; test: (body: string, source: string) => boolean }
export type Lesson = {
  id: string
  title: string
  /** HTML shown beside the practice editor */
  intro: string
  starter: string
  solution: string
  goals: Goal[]
  /** extra files the practice folder needs */
  files?: ('image' | 'bib')[]
}

const doc = (body: string, preamble = '') => `\\documentclass{article}\n${preamble}\\begin{document}\n\n${body.trim()}\n\n\\end{document}\n`

/** Does the body use \name (optionally with the given argument)? */
const has = (re: RegExp) => (body: string) => re.test(body)

export const LESSONS: Lesson[] = [
  {
    id: 'first',
    title: 'Your first document',
    intro: `
      <p>A LaTeX document is plain text with <b>commands</b> that start with a backslash, like <code>\\section</code>.
      LaTeX reads it and produces a nicely typeset PDF.</p>
      <p>Every document has the same shape:</p>
      <pre>\\documentclass{article}   ← what kind of document
\\begin{document}
  …everything you write goes here…
\\end{document}</pre>
      <p>Everything between <code>\\begin{document}</code> and <code>\\end{document}</code> appears in the PDF.
      The part before it, the <b>preamble</b>, holds settings.</p>
      <p>Press <b>Check</b> (or Ctrl+Enter) to compile and see the PDF on the right.</p>`,
    starter: doc('Hello, world!'),
    solution: doc('Hello, Ada! This is my first LaTeX document.'),
    goals: [
      { text: 'Change “world” to your own name', hint: 'Edit the line “Hello, world!” in the editor.', test: b => /Hello,\s*(?!world)[A-Za-z]/.test(b) },
      { text: 'Add a second sentence after it', hint: 'Type another sentence on the same line or the next one.', test: b => (b.match(/[.!?](\s|$)/g) ?? []).length >= 2 },
    ],
  },
  {
    id: 'paragraphs',
    title: 'Paragraphs and special characters',
    intro: `
      <p>LaTeX decides the layout for you. A <b>single line break</b> is just a space; to start a <b>new paragraph</b>, leave an empty line.</p>
      <p>A few characters have special meanings, so you type them with a backslash in front:</p>
      <pre>\\%   \\$   \\&amp;   \\#   \\_   \\{   \\}</pre>
      <p>A plain <code>%</code> starts a <b>comment</b>: the rest of that line is ignored, which is handy for notes to yourself.</p>`,
    starter: doc('% This line is a comment and will not appear in the PDF.\nWrite your first paragraph here.\n\nWrite your second paragraph here.'),
    solution: doc('% This line is a comment and will not appear in the PDF.\nLaTeX makes long documents easy.\n\nAbout 50\\% of the class paid \\$10 \\& got a T-shirt.'),
    goals: [
      { text: 'Write two paragraphs separated by an empty line', hint: 'Leave one completely empty line between them.', test: b => b.replace(/^%.*$/gm, '').trim().split(/\n\s*\n/).filter(p => p.trim().length > 10).length >= 2 },
      { text: 'Write “50% of the class paid $10 & got a T-shirt” correctly', hint: 'Use \\% for %, \\$ for $ and \\& for &.', test: b => /50\\%/.test(b) && /\\\$\s?10/.test(b) && /\\&/.test(b) },
    ],
  },
  {
    id: 'sections',
    title: 'Sections and structure',
    intro: `
      <p>Organise your writing with headings. LaTeX numbers them for you:</p>
      <pre>\\section{Introduction}
\\subsection{Background}
\\subsubsection{Details}</pre>
      <p>Add <code>\\tableofcontents</code> and LaTeX builds a table of contents from your headings. It's filled in on the second compile, and LaTeXDesk does that automatically.</p>
      <p>A title page needs <code>\\title{…}</code> and <code>\\author{…}</code> in the preamble, then <code>\\maketitle</code> in the document.</p>`,
    starter: doc('\\maketitle\n\nYour sections go here.', '\\title{My Report}\n\\author{Your Name}\n'),
    solution: doc('\\maketitle\n\\tableofcontents\n\n\\section{Introduction}\nWhy this matters.\n\n\\subsection{Background}\nWhat came before.\n\n\\section{Method}\nWhat I did.', '\\title{My Report}\n\\author{Ada Lovelace}\n'),
    goals: [
      { text: 'Add at least two \\section headings', hint: 'For example \\section{Introduction} and \\section{Method}.', test: b => (b.match(/\\section\*?\{/g) ?? []).length >= 2 },
      { text: 'Add a \\subsection inside one of them', hint: 'Put \\subsection{…} after a \\section.', test: has(/\\subsection\*?\{/) },
      { text: 'Add a table of contents', hint: 'Add \\tableofcontents after \\maketitle.', test: has(/\\tableofcontents/) },
      { text: 'Put your name in \\author', hint: 'Change “Your Name” in the preamble.', test: (_b, s) => /\\author\{(?!Your Name)[^}]+\}/.test(s) },
    ],
  },
  {
    id: 'emphasis',
    title: 'Bold, italic and emphasis',
    intro: `
      <p>Wrap text in a command to style it:</p>
      <pre>\\textbf{bold}   \\textit{italic}   \\emph{emphasis}   \\underline{underline}</pre>
      <p><code>\\emph</code> is the usual way to stress a word: it's italic, but inside italic text it switches back to upright.</p>
      <p>In LaTeXDesk you can also select text and press <b>Ctrl+B</b> or <b>Ctrl+I</b>, or use the toolbar.</p>`,
    starter: doc('This is an important result, and it really matters.'),
    solution: doc('This is an \\textbf{important} result, and it \\emph{really} matters.'),
    goals: [
      { text: 'Make “important” bold', hint: 'Write \\textbf{important}.', test: has(/\\textbf\{important\}/) },
      { text: 'Emphasise “really”', hint: 'Write \\emph{really} (or \\textit{really}).', test: has(/\\(emph|textit)\{really\}/) },
    ],
  },
  {
    id: 'lists',
    title: 'Lists',
    intro: `
      <p>Bulleted lists use <code>itemize</code>; numbered lists use <code>enumerate</code>. Each entry starts with <code>\\item</code>:</p>
      <pre>\\begin{itemize}
  \\item Apples
  \\item Pears
\\end{itemize}

\\begin{enumerate}
  \\item First step
  \\item Second step
\\end{enumerate}</pre>
      <p>Put a list inside an <code>\\item</code> to nest it.</p>`,
    starter: doc('Things to buy:\n\nSteps to follow:'),
    solution: doc('Things to buy:\n\\begin{itemize}\n  \\item Milk\n  \\item Bread\n  \\item Eggs\n\\end{itemize}\n\nSteps to follow:\n\\begin{enumerate}\n  \\item Mix\n  \\item Bake\n\\end{enumerate}'),
    goals: [
      { text: 'A bulleted list with three items', hint: 'Use \\begin{itemize} … \\end{itemize} with three \\item lines.', test: b => /\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/.test(b) && (/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/.exec(b)![1].match(/\\item/g) ?? []).length >= 3 },
      { text: 'A numbered list with two items', hint: 'Use \\begin{enumerate} … \\end{enumerate}.', test: b => /\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/.test(b) && (/\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/.exec(b)![1].match(/\\item/g) ?? []).length >= 2 },
    ],
  },
  {
    id: 'maths1',
    title: 'Maths: the basics',
    intro: `
      <p>Maths goes between dollar signs inside a sentence, <code>$E = mc^2$</code>, or on its own line between <code>\\[</code> and <code>\\]</code>.</p>
      <pre>x^2        superscript        x_i       subscript
\\frac{a}{b}  fraction          \\sqrt{x}  square root
\\pm \\times \\leq \\geq \\neq   ±  ×  ≤  ≥  ≠
\\alpha \\beta \\pi \\theta     Greek letters</pre>
      <p>Use braces to group: <code>x^{10}</code>, not <code>x^10</code>.</p>
      <p>Hover over maths in LaTeXDesk's Code mode to see a preview.</p>`,
    starter: doc('The solutions of $ax^2 + bx + c = 0$ are given by the quadratic formula:\n\n% write it here, on its own line'),
    solution: doc('The solutions of $ax^2 + bx + c = 0$ are given by the quadratic formula:\n\\[\n  x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\n\\]'),
    goals: [
      { text: 'Write the quadratic formula on its own line (\\[ … \\])', hint: 'Start with \\[ and end with \\].', test: has(/\\\[[\s\S]+\\\]/) },
      { text: 'Use a fraction, a square root and ±', hint: 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}', test: b => /\\frac/.test(b) && /\\sqrt/.test(b) && /\\pm/.test(b) },
    ],
  },
  {
    id: 'maths2',
    title: 'Maths: equations and alignment',
    intro: `
      <p>The <code>equation</code> environment numbers an equation. Give it a <code>\\label</code>, and refer to it anywhere with <code>\\ref</code>. The number updates by itself.</p>
      <pre>\\begin{equation}
  E = mc^2 \\label{eq:energy}
\\end{equation}
As equation~\\ref{eq:energy} shows…</pre>
      <p>For several lines lined up on the = sign, use <code>align*</code> (needs <code>\\usepackage{amsmath}</code>). Put <code>&amp;</code> before what you align on and end lines with <code>\\\\</code>:</p>
      <pre>\\begin{align*}
  (a+b)^2 &amp;= (a+b)(a+b) \\\\
          &amp;= a^2 + 2ab + b^2
\\end{align*}</pre>`,
    starter: doc('Expand the square:\n\n% an align* block here\n\nAnd a numbered equation:\n\n% an equation with a label, then refer to it', '\\usepackage{amsmath}\n'),
    solution: doc('Expand the square:\n\\begin{align*}\n  (a+b)^2 &= (a+b)(a+b) \\\\\n          &= a^2 + 2ab + b^2\n\\end{align*}\n\nAnd a numbered equation:\n\\begin{equation}\n  E = mc^2 \\label{eq:energy}\n\\end{equation}\nEquation~\\ref{eq:energy} is famous.', '\\usepackage{amsmath}\n'),
    goals: [
      { text: 'An align* block with at least two lines aligned on &=', hint: 'Use \\begin{align*} … \\end{align*}, with &= on each line and \\\\ between lines.', test: b => /\\begin\{align\*?\}[\s\S]*&=[\s\S]*\\\\[\s\S]*&=[\s\S]*\\end\{align\*?\}/.test(b) },
      { text: 'A numbered equation with a \\label', hint: 'Put \\label{eq:…} inside \\begin{equation} … \\end{equation}.', test: has(/\\begin\{equation\}[\s\S]*\\label\{[^}]+\}[\s\S]*\\end\{equation\}/) },
      { text: 'Refer to it with \\ref', hint: 'Write \\ref{…} with the same name as the label.', test: b => { const l = /\\label\{([^}]+)\}/.exec(b); return !!l && b.includes(`\\ref{${l[1]}}`) } },
    ],
  },
  {
    id: 'tables',
    title: 'Tables',
    intro: `
      <p>Tables use <code>tabular</code>. The column spec says how many columns there are and how each is aligned: <code>l</code>eft, <code>c</code>entre, <code>r</code>ight. Separate cells with <code>&amp;</code>, end rows with <code>\\\\</code>, and draw lines with <code>\\hline</code>:</p>
      <pre>\\begin{tabular}{l r}
  \\hline
  Fruit &amp; Price \\\\
  \\hline
  Apple &amp; 0.50 \\\\
  Pear  &amp; 0.75 \\\\
  \\hline
\\end{tabular}</pre>
      <p>Wrap it in a <code>table</code> environment to add a <code>\\caption</code>. The toolbar's <b>Table</b> button builds all of this for you.</p>`,
    starter: doc('% make a table with a caption here'),
    solution: doc('\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{l r}\n    \\hline\n    Fruit & Price \\\\\n    \\hline\n    Apple & 0.50 \\\\\n    Pear & 0.75 \\\\\n    \\hline\n  \\end{tabular}\n  \\caption{Fruit prices}\n\\end{table}'),
    goals: [
      { text: 'A tabular with at least 2 columns and 3 rows', hint: 'Each row has cells separated by & and ends with \\\\.', test: b => { const m = /\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/.exec(b); return !!m && (m[1].match(/\\\\/g) ?? []).length >= 3 && m[1].includes('&') } },
      { text: 'Horizontal lines with \\hline', hint: 'Put \\hline before the first row and after the last.', test: has(/\\hline/) },
      { text: 'A caption, inside a table environment', hint: 'Wrap the tabular in \\begin{table} … \\end{table} and add \\caption{…}.', test: has(/\\begin\{table\}[\s\S]*\\caption\{[^}]+\}[\s\S]*\\end\{table\}/) },
    ],
  },
  {
    id: 'figures',
    title: 'Figures and images',
    intro: `
      <p>Images need the <code>graphicx</code> package. A <code>figure</code> gives an image a caption and a number, and LaTeX places it where it fits best:</p>
      <pre>\\begin{figure}[h]
  \\centering
  \\includegraphics[width=0.6\\linewidth]{picture}
  \\caption{What this shows}
  \\label{fig:picture}
\\end{figure}</pre>
      <p>Refer to it with <code>Figure~\\ref{fig:picture}</code>. The practice folder has an image called <b>picture.png</b> for you to use. In your own projects, the toolbar's <b>Figure</b> button lists your images.</p>`,
    starter: doc('Here is a picture:\n\n% insert picture.png in a figure here', '\\usepackage{graphicx}\n'),
    solution: doc('Here is a picture, shown in Figure~\\ref{fig:picture}.\n\n\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.6\\linewidth]{picture}\n  \\caption{A practice picture}\n  \\label{fig:picture}\n\\end{figure}', '\\usepackage{graphicx}\n'),
    files: ['image'],
    goals: [
      { text: 'Include picture.png at 60% of the line width', hint: '\\includegraphics[width=0.6\\linewidth]{picture}', test: has(/\\includegraphics\[[^\]]*width\s*=\s*0?\.6\s*\\(linewidth|textwidth)[^\]]*\]\{picture(\.png)?\}/) },
      { text: 'Put it in a figure with a caption and a label', hint: 'Wrap it in \\begin{figure} … \\end{figure} with \\caption{…} and \\label{fig:…}.', test: has(/\\begin\{figure\}[\s\S]*\\caption\{[^}]+\}[\s\S]*\\label\{[^}]+\}[\s\S]*\\end\{figure\}/) },
      { text: 'Refer to the figure in the text with \\ref', hint: 'Figure~\\ref{fig:…} with the same name as the label.', test: b => { const l = /\\label\{(fig[^}]*)\}/.exec(b) ?? /\\label\{([^}]+)\}/.exec(b); return !!l && b.includes(`\\ref{${l[1]}}`) } },
    ],
  },
  {
    id: 'citations',
    title: 'References and citations',
    intro: `
      <p>Your sources live in a <b>.bib</b> file. Each entry has a key, like <code>knuth1984</code>. Cite it with <code>\\cite{knuth1984}</code>, and LaTeX formats the citation and the reference list for you.</p>
      <pre>As Knuth showed \\cite{knuth1984}, …

\\bibliographystyle{plain}
\\bibliography{refs}      ← refs.bib, without “.bib”</pre>
      <p>The practice folder has a <b>refs.bib</b> containing <code>knuth1984</code>. In real projects, the <b>Research</b> tab turns a DOI into a .bib entry, and Zotero users can cite straight from their library.</p>`,
    starter: doc('Typesetting maths well is hard.\n\n% cite knuth1984 above, then add the bibliography here'),
    solution: doc('Typesetting maths well is hard \\cite{knuth1984}.\n\n\\bibliographystyle{plain}\n\\bibliography{refs}'),
    files: ['bib'],
    goals: [
      { text: 'Cite knuth1984 with \\cite', hint: 'Write \\cite{knuth1984} after the sentence.', test: has(/\\cite\{[^}]*knuth1984[^}]*\}/) },
      { text: 'Choose a bibliography style', hint: '\\bibliographystyle{plain}', test: has(/\\bibliographystyle\{[^}]+\}/) },
      { text: 'Print the reference list from refs.bib', hint: '\\bibliography{refs}', test: has(/\\bibliography\{refs\}/) },
    ],
  },
  {
    id: 'packages',
    title: 'Packages and your own commands',
    intro: `
      <p><b>Packages</b> add features. Load them in the preamble with <code>\\usepackage{…}</code>:</p>
      <pre>\\usepackage{amssymb}   % more maths symbols, e.g. \\mathbb{R}
\\usepackage{xcolor}    % \\textcolor{red}{text}</pre>
      <p>You can also make <b>your own commands</b> for things you type often:</p>
      <pre>\\newcommand{\\R}{\\mathbb{R}}
… for every $x \\in \\R$ …</pre>
      <p>LaTeXDesk adds the packages its toolbar buttons need by itself, so you'll rarely do this by hand.</p>`,
    starter: doc('For every real number $x$, $x^2 \\geq 0$.'),
    solution: doc('For every $x \\in \\R$, $x^2 \\geq 0$. \\textcolor{blue}{Neat!}', '\\usepackage{amssymb}\n\\usepackage{xcolor}\n\\newcommand{\\R}{\\mathbb{R}}\n'),
    goals: [
      { text: 'Load the amssymb package', hint: '\\usepackage{amssymb} in the preamble (before \\begin{document}).', test: (_b, s) => /\\usepackage(\[[^\]]*\])?\{[^}]*amssymb[^}]*\}/.test(s.split('\\begin{document}')[0]) },
      { text: 'Define \\R as \\mathbb{R} and use it in the sentence', hint: '\\newcommand{\\R}{\\mathbb{R}} in the preamble, then $x \\in \\R$.', test: (b, s) => /\\newcommand\{?\\R\}?\{\\mathbb\{R\}\}/.test(s) && /\\R(?![a-zA-Z])/.test(b) },
      { text: 'Colour some text with xcolor', hint: '\\usepackage{xcolor}, then \\textcolor{blue}{…}.', test: (b, s) => /\\usepackage(\[[^\]]*\])?\{[^}]*xcolor[^}]*\}/.test(s) && /\\textcolor\{[^}]+\}\{[^}]+\}/.test(b) },
    ],
  },
]

/** refs.bib for the citations lesson */
export const PRACTICE_BIB = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}
`
