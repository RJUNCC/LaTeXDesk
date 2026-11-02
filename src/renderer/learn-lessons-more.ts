// More Learn lessons: bibliography styles, long documents, slides and diagrams. Same format as learn-lessons.ts.
import type { Lesson } from './learn-lessons'

const has = (re: RegExp) => (body: string) => re.test(body)
const preambleOf = (source: string) => source.split('\\begin{document}')[0]

/** After "References and citations". */
export const BIBSTYLE_LESSON: Lesson = {
  id: 'bibstyles',
  title: 'Citation styles',
  intro: String.raw`
      <p>Different fields cite differently: numbers like <i>[1]</i> in maths and engineering, or
      <i>(Knuth, 1984)</i> in the sciences and humanities. The <b>natbib</b> package gives you both kinds of citation command:</p>
      <pre>\citet{knuth1984}   → Knuth (1984) showed …
\citep{knuth1984}   → … as shown (Knuth, 1984).</pre>
      <p>The <b>bibliography style</b> decides how they look. <code>plainnat</code> gives author–year;
      journals often supply their own (<code>IEEEtran</code>, <code>apalike</code>, …).</p>
      <pre>\usepackage{natbib}        ← in the preamble
…
\bibliographystyle{plainnat}
\bibliography{refs}</pre>
      <p>The practice <b>refs.bib</b> has <code>knuth1984</code> and <code>lamport1986</code>. The templates for IEEE, ACM, APA, Springer and Elsevier
      are already set up with their styles.</p>`,
  starter: String.raw`\documentclass{article}

\begin{document}

TeX was designed for beautiful maths. LaTeX made it easier to use.

% cite knuth1984 in the first sentence (as the subject) and lamport1986 in brackets in the second

\end{document}
`,
  solution: String.raw`\documentclass{article}
\usepackage{natbib}

\begin{document}

\citet{knuth1984} designed TeX for beautiful maths. LaTeX made it easier to use \citep{lamport1986}.

\bibliographystyle{plainnat}
\bibliography{refs}

\end{document}
`,
  files: ['bib'],
  goals: [
    { text: 'Load natbib in the preamble', hint: '\\usepackage{natbib} before \\begin{document}.', test: (_b, s) => /\\usepackage(\[[^\]]*\])?\{[^}]*natbib[^}]*\}/.test(preambleOf(s)) },
    { text: 'Cite knuth1984 as the subject of a sentence with \\citet', hint: '\\citet{knuth1984} designed TeX …', test: has(/\\citet\{[^}]*knuth1984[^}]*\}/) },
    { text: 'Cite lamport1986 in brackets with \\citep', hint: '… easier to use \\citep{lamport1986}.', test: has(/\\citep\{[^}]*lamport1986[^}]*\}/) },
    { text: 'Use the author–year style plainnat', hint: '\\bibliographystyle{plainnat} and \\bibliography{refs} at the end.', test: b => /\\bibliographystyle\{plainnat\}/.test(b) && /\\bibliography\{refs\}/.test(b) },
  ],
}

/** The chapter file the long-documents lesson includes. */
export const PRACTICE_CHAPTER = String.raw`% results.tex: a part of the document kept in its own file
\section{Results}
\label{sec:results}
The method worked on every test case.
`

export const MORE_LESSONS: Lesson[] = [
  {
    id: 'long',
    title: 'Long documents',
    intro: String.raw`
      <p>A thesis or report is easier to manage split into files: one per chapter. The main file pulls them in:</p>
      <pre>\input{results}      ← the contents of results.tex, right here</pre>
      <p>(<code>\include</code> does the same but starts a new page; use it for chapters.)</p>
      <p>Number things and refer to them with <b>labels</b>: put <code>\label{…}</code> after a section, figure, table or equation, and
      <code>\ref{…}</code> prints its number, which stays right when you reorder things.</p>
      <pre>\section{Introduction}\label{sec:intro}
… see Section~\ref{sec:results}.     ← ~ keeps "Section" and the number together</pre>
      <p><code>\tableofcontents</code> lists the sections. LaTeX compiles twice to fill in numbers; LaTeXDesk does that for you.</p>
      <p>The practice folder has <b>results.tex</b>, which already contains <code>\label{sec:results}</code>.</p>`,
    starter: String.raw`\documentclass{article}

\begin{document}

\section{Introduction}
This report describes a small experiment. The results are in the next section.

\end{document}
`,
    solution: String.raw`\documentclass{article}

\begin{document}

\tableofcontents

\section{Introduction}
\label{sec:intro}
This report describes a small experiment. The results are in Section~\ref{sec:results}.

\input{results}

\end{document}
`,
    files: ['chapter'],
    goals: [
      { text: 'Include results.tex with \\input', hint: '\\input{results} after the introduction.', test: has(/\\(input|include)\{results(\.tex)?\}/) },
      { text: 'Label the introduction', hint: '\\label{sec:intro} right after \\section{Introduction}.', test: has(/\\section\{Introduction\}\s*\\label\{[^}]+\}/) },
      { text: 'Refer to the results section by its number', hint: 'Write Section~\\ref{sec:results} in the introduction.', test: has(/\\ref\{sec:results\}/) },
      { text: 'Add a table of contents', hint: '\\tableofcontents just after \\begin{document}.', test: has(/\\tableofcontents/) },
    ],
  },
  {
    id: 'slides',
    title: 'Slides with Beamer',
    intro: String.raw`
      <p>Presentations use the <b>beamer</b> document class. Each slide is a <code>frame</code>:</p>
      <pre>\begin{frame}{Slide title}
  \begin{itemize}
    \item First point
    \pause            ← the next point appears on a click
    \item Second point
  \end{itemize}
\end{frame}</pre>
      <p>The title slide comes from <code>\titlepage</code> (with <code>\title</code> and <code>\author</code> in the preamble).
      Change the look with a theme: <code>\usetheme{Madrid}</code>, <code>Boadilla</code>, <code>metropolis</code>, …</p>
      <p>The PDF is the presentation: open it full-screen to present. <b>Templates → Presentation (Beamer)</b> starts a full deck.</p>`,
    starter: String.raw`\documentclass{beamer}

\title{My Talk}
\author{Your Name}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\end{document}
`,
    solution: String.raw`\documentclass{beamer}
\usetheme{Madrid}

\title{My Talk}
\author{Your Name}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Why this matters}
  \begin{itemize}
    \item It saves time
    \pause
    \item It looks good
  \end{itemize}
\end{frame}

\end{document}
`,
    goals: [
      { text: 'Choose a theme', hint: '\\usetheme{Madrid} in the preamble.', test: (_b, s) => /\\usetheme\{[^}]+\}/.test(preambleOf(s)) },
      { text: 'Add a second slide with a title', hint: '\\begin{frame}{Why this matters} … \\end{frame}', test: b => (b.match(/\\begin\{frame\}/g) ?? []).length >= 2 && /\\begin\{frame\}(\[[^\]]*\])?\{[^}]+\}|\\frametitle\{[^}]+\}/.test(b) },
      { text: 'Put a list with at least two points on it', hint: 'An itemize with two \\item lines inside the new frame.', test: b => /\\begin\{itemize\}[\s\S]*\\item[\s\S]*\\item[\s\S]*\\end\{itemize\}/.test(b) },
      { text: 'Reveal the points one at a time', hint: 'Put \\pause between the two \\item lines.', test: has(/\\pause/) },
    ],
  },
  {
    id: 'diagrams',
    title: 'Diagrams with TikZ',
    intro: String.raw`
      <p><b>TikZ</b> draws diagrams in LaTeX, with the same fonts as your text. Coordinates are in centimetres:</p>
      <pre>\begin{tikzpicture}
  \draw (0,0) -- (3,0);                  ← a line
  \draw[->] (0,0) -- (0,2);              ← an arrow
  \draw (1.5,1) circle (0.5);            ← a circle, radius 0.5
  \fill[blue!30] (3,1) rectangle (4,2);  ← a filled box
  \node at (1.5,-0.4) {label};           ← text
\end{tikzpicture}</pre>
      <p>Every command ends with a semicolon. Load it with <code>\usepackage{tikz}</code>.
      The <b>Markov</b> button on the toolbar draws chain diagrams in TikZ for you.</p>`,
    starter: String.raw`\documentclass{article}
\usepackage{tikz}

\begin{document}

\begin{tikzpicture}
  % draw here
\end{tikzpicture}

\end{document}
`,
    solution: String.raw`\documentclass{article}
\usepackage{tikz}

\begin{document}

\begin{tikzpicture}
  \draw[->] (0,0) -- (3,0);
  \draw (1.5,1.2) circle (0.6);
  \fill[blue!30] (3.5,0.5) rectangle (4.5,1.5);
  \node at (1.5,-0.4) {my first diagram};
\end{tikzpicture}

\end{document}
`,
    goals: [
      { text: 'Draw a line or an arrow', hint: '\\draw[->] (0,0) -- (3,0);', test: has(/\\draw[^;]*--[^;]*;/) },
      { text: 'Draw a circle', hint: '\\draw (1.5,1.2) circle (0.6);', test: has(/circle\s*\([^)]*\)\s*;/) },
      { text: 'Fill a shape with a colour', hint: '\\fill[blue!30] (3.5,0.5) rectangle (4.5,1.5);', test: has(/\\fill\[[^\]]+\]|\\filldraw|fill\s*=/) },
      { text: 'Add a text label', hint: '\\node at (1.5,-0.4) {my first diagram};', test: has(/\\node[^;]*\{[^}]+\}\s*;|node\s*(\[[^\]]*\])?\s*\{[^}]+\}/) },
    ],
  },
]
