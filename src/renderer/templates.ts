// Starter documents for "New from Template". Only uses packages that ship with a basic MiKTeX/TeX Live.

export type Template = {
  id: string
  name: string
  description: string
  main: string
  files: Record<string, string>
}

const sampleBib = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@article{lamport1986,
  author  = {Leslie Lamport},
  title   = {{\\LaTeX}: A Document Preparation System},
  journal = {Addison-Wesley},
  year    = {1986}
}
`

const figurePlaceholder = `\\framebox[0.6\\linewidth]{\\rule{0pt}{3cm}\\raisebox{1.4cm}{Your image here}}`

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank document',
    description: 'A minimal article: title and one section, nothing else.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass{article}
\\usepackage[utf8]{inputenc}

\\title{Untitled}
\\author{Your Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Introduction}
Start writing here.

\\end{document}
`,
    },
  },
  {
    id: 'article',
    name: 'Article / Paper',
    description: 'Abstract, sections, an equation, a table, a figure and a bibliography.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[11pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}

\\title{The Title of Your Paper}
\\author{Your Name \\\\ \\small Your Institution \\\\ \\small \\texttt{you@example.com}}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
A short summary of the problem, what you did, and what you found.
\\end{abstract}

\\section{Introduction}\\label{sec:intro}
Introduce the topic and motivate the work. Classic references include
\\cite{knuth1984} and \\cite{lamport1986}. Section~\\ref{sec:method} describes the method.

\\section{Method}\\label{sec:method}
Equations are numbered automatically:
\\begin{equation}
  E = mc^2 \\label{eq:energy}
\\end{equation}
and can be referred to as Equation~\\eqref{eq:energy}.

\\section{Results}\\label{sec:results}
Table~\\ref{tab:results} summarises the results.

\\begin{table}[h]
  \\centering
  \\begin{tabular}{lcc}
    \\toprule
    \\textbf{Method} & \\textbf{Accuracy} & \\textbf{Time (s)} \\\\
    \\midrule
    Baseline & 0.82 & 1.2 \\\\
    Ours     & 0.91 & 0.9 \\\\
    \\bottomrule
  \\end{tabular}
  \\caption{Comparison of methods.}
  \\label{tab:results}
\\end{table}

\\begin{figure}[h]
  \\centering
  ${figurePlaceholder}
  % Replace the box above with: \\includegraphics[width=0.6\\linewidth]{your-image.png}
  \\caption{A figure caption.}
  \\label{fig:example}
\\end{figure}

\\section{Conclusion}
Summarise the contributions and future work.

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
      'refs.bib': sampleBib,
    },
  },
  {
    id: 'report',
    name: 'Report / Thesis',
    description: 'Title page, table of contents, chapters in separate files, bibliography.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[12pt,a4paper]{report}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{hyperref}

\\begin{document}

\\begin{titlepage}
  \\centering
  \\vspace*{3cm}
  {\\Huge\\bfseries Title of the Report\\par}
  \\vspace{1.5cm}
  {\\Large Your Name\\par}
  \\vspace{0.5cm}
  {\\large Department, University\\par}
  \\vfill
  {\\large \\today\\par}
\\end{titlepage}

\\begin{abstract}
A one-page summary of the whole report.
\\end{abstract}

\\tableofcontents

\\input{chapters/introduction}
\\input{chapters/background}
\\input{chapters/conclusion}

\\bibliographystyle{plain}
\\bibliography{refs}

\\end{document}
`,
      'chapters/introduction.tex': `\\chapter{Introduction}\\label{ch:intro}
State the problem and the aims of this report.

\\section{Motivation}
Why does this matter?

\\section{Outline}
Chapter~\\ref{ch:background} covers the background and Chapter~\\ref{ch:conclusion} concludes.
`,
      'chapters/background.tex': `\\chapter{Background}\\label{ch:background}
Summarise prior work, e.g.\\ \\cite{knuth1984}.

\\section{Key Ideas}
\\begin{itemize}
  \\item First idea
  \\item Second idea
\\end{itemize}
`,
      'chapters/conclusion.tex': `\\chapter{Conclusion}\\label{ch:conclusion}
Summarise the findings and suggest future work.
`,
      'refs.bib': sampleBib,
    },
  },
  {
    id: 'beamer',
    name: 'Presentation (Beamer)',
    description: 'Slides with a title page, outline, bullet points, columns and maths.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass{beamer}
\\usetheme{Madrid}
\\usepackage[utf8]{inputenc}
\\usepackage{amsmath}

\\title{Presentation Title}
\\subtitle{An optional subtitle}
\\author{Your Name}
\\institute{Your Institution}
\\date{\\today}

\\begin{document}

\\begin{frame}
  \\titlepage
\\end{frame}

\\begin{frame}{Outline}
  \\tableofcontents
\\end{frame}

\\section{Introduction}
\\begin{frame}{Introduction}
  \\begin{itemize}
    \\item First point
    \\item Second point \\pause
    \\item This one appears on click
  \\end{itemize}
\\end{frame}

\\section{Details}
\\begin{frame}{Two Columns}
  \\begin{columns}
    \\column{0.5\\textwidth}
      Text on the left.
    \\column{0.5\\textwidth}
      \\begin{block}{A block}
        Highlighted content on the right.
      \\end{block}
  \\end{columns}
\\end{frame}

\\begin{frame}{Some Maths}
  \\[
    \\int_0^1 x^2 \\, dx = \\frac{1}{3}
  \\]
\\end{frame}

\\begin{frame}
  \\centering \\Huge Thank you!
\\end{frame}

\\end{document}
`,
    },
  },
  {
    id: 'homework',
    name: 'Homework / Assignment',
    description: 'Numbered problems with solutions, theorem environments and maths packages.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath, amssymb, amsthm}
\\usepackage{enumitem}
\\usepackage{fancyhdr}

\\newcommand{\\coursename}{Course 101}
\\newcommand{\\assignment}{Assignment 1}
\\newcommand{\\studentname}{Your Name}

\\pagestyle{fancy}
\\setlength{\\headheight}{14pt}
\\fancyhf{}
\\lhead{\\studentname}
\\chead{\\coursename}
\\rhead{\\assignment}
\\cfoot{\\thepage}

\\theoremstyle{definition}
\\newtheorem{problem}{Problem}
\\newenvironment{solution}{\\begin{proof}[Solution]}{\\end{proof}}

\\begin{document}

\\begin{center}
  {\\LARGE \\assignment}\\\\[4pt]
  \\studentname \\quad--\\quad \\today
\\end{center}

\\begin{problem}
Show that $\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}$.
\\end{problem}
\\begin{solution}
By induction on $n$. For $n = 1$ both sides equal $1$. Assume it holds for $n$; then
\\[
  \\sum_{k=1}^{n+1} k = \\frac{n(n+1)}{2} + (n+1) = \\frac{(n+1)(n+2)}{2}.
\\]
\\end{solution}

\\begin{problem}
Answer the following:
\\begin{enumerate}[label=(\\alph*)]
  \\item First part.
  \\item Second part.
\\end{enumerate}
\\end{problem}
\\begin{solution}
\\begin{enumerate}[label=(\\alph*)]
  \\item Answer to the first part.
  \\item Answer to the second part.
\\end{enumerate}
\\end{solution}

\\end{document}
`,
    },
  },
  {
    id: 'lab',
    name: 'Lab Report',
    description: 'Aim, theory, method, results table, discussion and conclusion.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{booktabs}

\\title{Lab Report: Experiment Title}
\\author{Your Name \\\\ \\small Lab partner: Partner Name}
\\date{\\today}

\\begin{document}
\\maketitle

\\section{Aim}
What the experiment sets out to measure or demonstrate.

\\section{Theory}
The relevant relationship, for example
\\begin{equation}
  T = 2\\pi \\sqrt{\\frac{L}{g}}
\\end{equation}

\\section{Apparatus and Method}
\\begin{enumerate}
  \\item Set up the apparatus.
  \\item Take measurements.
  \\item Repeat three times.
\\end{enumerate}

\\section{Results}
\\begin{table}[h]
  \\centering
  \\begin{tabular}{cc}
    \\toprule
    \\textbf{Length (m)} & \\textbf{Period (s)} \\\\
    \\midrule
    0.50 & 1.419 \\\\
    0.75 & 1.738 \\\\
    1.00 & 2.006 \\\\
    \\bottomrule
  \\end{tabular}
  \\caption{Measured periods.}
  \\label{tab:data}
\\end{table}

\\section{Discussion}
Interpret the results and discuss sources of error.

\\section{Conclusion}
Summarise the findings.

\\end{document}
`,
    },
  },
  {
    id: 'letter',
    name: 'Letter',
    description: 'A formal letter with addresses, opening and closing.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[11pt]{letter}
\\usepackage[margin=1in]{geometry}

\\signature{Your Name}
\\address{Your Street 1 \\\\ Your City \\\\ Postcode}

\\begin{document}

\\begin{letter}{Recipient Name \\\\ Their Organisation \\\\ Street 2 \\\\ City}

\\opening{Dear Recipient,}

The first paragraph states why you are writing.

The second paragraph gives the details.

\\closing{Yours sincerely,}

\\end{letter}
\\end{document}
`,
    },
  },
  {
    id: 'cv',
    name: 'CV / Résumé',
    description: 'A clean one-page CV with sections for experience, education and skills.',
    main: 'main.tex',
    files: {
      'main.tex': `\\documentclass[11pt]{article}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{titlesec}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{xcolor}

\\pagestyle{empty}
\\setlength{\\parindent}{0pt}
\\definecolor{accent}{RGB}{19,138,7}
\\titleformat{\\section}{\\large\\bfseries\\color{accent}}{}{0pt}{}[\\titlerule]
\\titlespacing{\\section}{0pt}{12pt}{6pt}
\\setlist[itemize]{leftmargin=*, nosep}

% \\entry{Title}{Dates}{Place}
\\newcommand{\\entry}[3]{\\textbf{#1} \\hfill #2\\par \\textit{#3}\\par\\vspace{2pt}}

\\begin{document}

\\begin{center}
  {\\Huge\\bfseries Your Name}\\\\[4pt]
  City, Country \\quad|\\quad \\href{mailto:you@example.com}{you@example.com} \\quad|\\quad
  \\href{https://github.com/you}{github.com/you}
\\end{center}

\\section{Experience}
\\entry{Job Title}{2023 -- Present}{Company Name}
\\begin{itemize}
  \\item Achievement with a measurable result.
  \\item Another responsibility or project.
\\end{itemize}
\\vspace{6pt}
\\entry{Previous Job Title}{2020 -- 2023}{Previous Company}
\\begin{itemize}
  \\item What you did and the impact it had.
\\end{itemize}

\\section{Education}
\\entry{Degree, Subject}{2016 -- 2020}{University Name}

\\section{Skills}
\\textbf{Languages:} English, \\ldots \\\\
\\textbf{Technical:} \\LaTeX, Python, \\ldots

\\end{document}
`,
    },
  },
]
