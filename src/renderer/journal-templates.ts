// Journal, conference and university templates for "New from Template". Each uses the publisher's own class
// from TeX Live (installed automatically by MiKTeX or the built-in engine on first compile) and BibTeX, so
// they compile with either engine. Publishers update their classes; check the journal's own instructions too.
import type { Template } from './templates'

const refs = String.raw`@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\TeX}book},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@article{lamport1986,
  author  = {Leslie Lamport},
  title   = {Document Preparation Systems},
  journal = {Computing Surveys},
  volume  = {18},
  number  = {2},
  pages   = {1--20},
  year    = {1986}
}
`

const body = String.raw`\section{Introduction}
State the problem, why it matters, and what this paper contributes. Earlier work includes
the typesetting system of Knuth~\cite{knuth1984} and later document preparation
systems~\cite{lamport1986}.

\section{Method}
Describe what you did, in enough detail that someone could repeat it. Number the equations
you refer to:
\begin{equation}
  y = \beta_0 + \beta_1 x + \varepsilon .
  \label{eq:model}
\end{equation}

\section{Results}
Report what you found. Table~\ref{tab:results} summarises the data and
Equation~\eqref{eq:model} the model.

\begin{table}[t]
  \centering
  \caption{Summary of the results.}
  \label{tab:results}
  \begin{tabular}{lrr}
    \toprule
    Group & $n$ & Mean \\
    \midrule
    Control   & 24 & 3.1 \\
    Treatment & 26 & 4.7 \\
    \bottomrule
  \end{tabular}
\end{table}

\section{Conclusion}
Summarise the findings and what should be done next.
`

export const JOURNAL_TEMPLATES: Template[] = [
  {
    id: 'ieee',
    group: 'Journals and conferences',
    name: 'IEEE conference paper',
    description: 'IEEEtran, two columns: author blocks, abstract, keywords, IEEE reference style.',
    main: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[conference]{IEEEtran}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{cite}

\begin{document}

\title{Paper Title}

\author{\IEEEauthorblockN{First Author}
\IEEEauthorblockA{Department, University\\
City, Country\\
first.author@example.edu}
\and
\IEEEauthorblockN{Second Author}
\IEEEauthorblockA{Company\\
City, Country\\
second.author@example.com}}

\maketitle

\begin{abstract}
One paragraph of 150--250 words: the problem, the approach, the main results and why they matter.
\end{abstract}

\begin{IEEEkeywords}
keyword one, keyword two, keyword three
\end{IEEEkeywords}

` + body + String.raw`
\bibliographystyle{IEEEtran}
\bibliography{refs}

\end{document}
`,
      'refs.bib': refs,
    },
  },
  {
    id: 'acm',
    group: 'Journals and conferences',
    name: 'ACM conference paper',
    description: 'acmart (sigconf): CCS concepts, keywords and the ACM reference format.',
    main: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[sigconf]{acmart}
\usepackage{booktabs}

% for a draft; the conference provides the real rights information
\setcopyright{none}
\settopmatter{printacmref=false}
\renewcommand\footnotetextcopyrightpermission[1]{}

\begin{document}

\title{Paper Title}

\author{First Author}
\affiliation{%
  \institution{University}
  \city{City}
  \country{Country}}
\email{first.author@example.edu}

\author{Second Author}
\affiliation{%
  \institution{Company}
  \city{City}
  \country{Country}}
\email{second.author@example.com}

\begin{abstract}
One paragraph: the problem, the approach, the main results and why they matter.
\end{abstract}

\begin{CCSXML}
<ccs2012>
<concept>
<concept_id>10010147</concept_id>
<concept_desc>Computing methodologies</concept_desc>
<concept_significance>500</concept_significance>
</concept>
</ccs2012>
\end{CCSXML}
\ccsdesc[500]{Computing methodologies}

\keywords{keyword one, keyword two, keyword three}

\maketitle

` + body + String.raw`
\bibliographystyle{ACM-Reference-Format}
\bibliography{refs}

\end{document}
`,
      'refs.bib': refs,
    },
  },
  {
    id: 'apa7',
    group: 'Journals and conferences',
    name: 'APA 7th edition paper',
    description: 'apa7 class, student paper layout, APA citations (Author, year) with BibTeX.',
    main: 'main.tex',
    files: {
      'main.tex': String.raw`% stu = student paper; use man for a manuscript submitted to a journal
\documentclass[stu,12pt,natbib]{apa7}
\usepackage[american]{babel}
\usepackage{booktabs}

\title{Paper Title}
\shorttitle{Short Title}
\authorsnames{Your Name}
\authorsaffiliations{Department, University}
\course{COURSE 101: Course Name}
\professor{Professor Name}
\duedate{January 1, 2026}

\abstract{One paragraph: the question, the method, the main findings and what they mean.}
\keywords{keyword one, keyword two}

\begin{document}
\maketitle

Begin with the introduction (APA papers don't put a heading on it). Cite with
\citet{knuth1984} in a sentence, or in parentheses \citep{lamport1986}.

\section{Method}
\subsection{Participants}
Describe who took part.

\subsection{Procedure}
Describe what they did.

\section{Results}
Report the results, with statistics such as $M = 4.7$, $SD = 1.2$.

\section{Discussion}
Interpret the findings and their limits.

\bibliographystyle{apacite}
\bibliography{refs}

\end{document}
`,
      'refs.bib': refs,
    },
  },
  {
    id: 'springer-lncs',
    group: 'Journals and conferences',
    name: 'Springer LNCS paper',
    description: 'llncs class for Lecture Notes in Computer Science and many Springer proceedings.',
    main: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[runningheads]{llncs}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}

\begin{document}

\title{Paper Title}
\titlerunning{Short Title}

\author{First Author\inst{1} \and Second Author\inst{2}}
\authorrunning{F. Author and S. Author}
\institute{University, City, Country \email{first.author@example.edu} \and
Company, City, Country \email{second.author@example.com}}

\maketitle

\begin{abstract}
One paragraph of 150--250 words summarising the paper.
\keywords{Keyword one \and Keyword two \and Keyword three.}
\end{abstract}

` + body + String.raw`
\bibliographystyle{splncs04}
\bibliography{refs}

\end{document}
`,
      'refs.bib': refs,
    },
  },
  {
    id: 'elsevier',
    group: 'Journals and conferences',
    name: 'Elsevier journal article',
    description: 'elsarticle: front matter with affiliations, highlights-ready abstract and keywords.',
    main: 'main.tex',
    files: {
      'main.tex': String.raw`\documentclass[preprint,12pt]{elsarticle}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}

\journal{Journal Name}

\begin{document}

\begin{frontmatter}
\title{Article Title}

\author[uni]{First Author\corref{cor}}
\ead{first.author@example.edu}
\author[company]{Second Author}
\cortext[cor]{Corresponding author}
\affiliation[uni]{organization={University}, city={City}, country={Country}}
\affiliation[company]{organization={Company}, city={City}, country={Country}}

\begin{abstract}
One paragraph summarising the article.
\end{abstract}

\begin{keyword}
keyword one \sep keyword two \sep keyword three
\end{keyword}
\end{frontmatter}

` + body + String.raw`
\bibliographystyle{elsarticle-num}
\bibliography{refs}

\end{document}
`,
      'refs.bib': refs,
    },
  },
  {
    id: 'thesis',
    group: 'University',
    name: 'Thesis or dissertation',
    description: 'Title page, abstract, acknowledgements, contents, chapters in their own files, appendix, bibliography.',
    main: 'thesis.tex',
    files: {
      'thesis.tex': String.raw`\documentclass[12pt,oneside]{report}
\usepackage[margin=1in]{geometry}
\usepackage{amsmath,amssymb,amsthm}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{setspace}
\usepackage[hidelinks]{hyperref}
\usepackage[nottoc]{tocbibind}

\newtheorem{theorem}{Theorem}[chapter]
\onehalfspacing

\begin{document}

% ---------- front matter (roman page numbers) ----------
\pagenumbering{roman}
\begin{titlepage}
  \centering
  \vspace*{2cm}
  {\LARGE\bfseries Thesis Title\par}
  \vspace{1.5cm}
  {\Large Your Name\par}
  \vfill
  A thesis submitted in partial fulfilment of the requirements\\
  for the degree of Doctor of Philosophy\par
  \vspace{1cm}
  Department, University\par
  \vspace{0.5cm}
  2026
\end{titlepage}

\chapter*{Abstract}
\addcontentsline{toc}{chapter}{Abstract}
Summarise the question, the approach, the results and the contribution, usually in under 350 words.

\chapter*{Acknowledgements}
Thank the people and organisations who helped.

\tableofcontents
\listoffigures
\listoftables

% ---------- the chapters (arabic page numbers) ----------
\clearpage
\pagenumbering{arabic}
\include{chapters/introduction}
\include{chapters/background}
\include{chapters/conclusion}

\appendix
\include{chapters/appendix}

\bibliographystyle{plain}
\bibliography{refs}

\end{document}
`,
      'chapters/introduction.tex': String.raw`\chapter{Introduction}
\label{ch:intro}
Introduce the topic, the research questions and how the thesis is organised:
Chapter~\ref{ch:background} reviews earlier work and Chapter~\ref{ch:conclusion} concludes.
`,
      'chapters/background.tex': String.raw`\chapter{Background}
\label{ch:background}
Review the literature, starting from the foundations~\cite{knuth1984,lamport1986}.

\begin{theorem}
State results formally where it helps.
\end{theorem}

\begin{table}[ht]
  \centering
  \caption{An example table.}
  \begin{tabular}{lr}
    \toprule
    Item & Value \\
    \midrule
    A & 1 \\
    B & 2 \\
    \bottomrule
  \end{tabular}
\end{table}
`,
      'chapters/conclusion.tex': String.raw`\chapter{Conclusion}
\label{ch:conclusion}
Summarise the contributions, the limitations and future work.
`,
      'chapters/appendix.tex': String.raw`\chapter{Additional Material}
Put long proofs, extra tables or code here.
`,
      'refs.bib': refs,
    },
  },
]
