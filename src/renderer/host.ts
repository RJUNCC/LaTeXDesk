// What feature modules (AI tab, tasks, research, history…) may use from the app shell in main.ts.
import type { EditorView } from '@codemirror/view'
import type { LatexLogEntry } from '../overleaf/latex-log-parser'
import type { ReviewHost } from './diff-review'
import type { FormatContext } from './format'

export type StatusKind = 'ok' | 'warn' | 'error' | ''

export type AppHost = ReviewHost & {
  view: EditorView
  format: FormatContext
  root(): string | null
  currentPath(): string | null
  mainFile(): string | null
  files(): { path: string; editable: boolean }[]
  refreshFiles(): Promise<void>
  openFile(path: string, line?: number): Promise<void>
  save(): Promise<void>
  compile(): Promise<void>
  setStatus(text: string, kind?: StatusKind): void
  logEntries(): LatexLogEntry[]
  /** Map a path printed in the TeX log to a project path. */
  logFileToProject(file: string | undefined): string | null
  /** Called after every compile with whether it produced a PDF without errors. */
  onCompiled(cb: (ok: boolean) => void): void
  onProjectOpened(cb: () => void): void
  /**
   * Replace the AI suggestions shown as underlines in a file (empty list clears them). Each is
   * anchored to its text, not a position, so it follows edits and disappears once the text is fixed.
   */
  setAiDiagnostics(path: string, items: { find: string; message: string; severity?: 'info' | 'warning' | 'error' }[], source?: string): void
  /** Raw disk access for app data inside the project (e.g. .texdesk/tasks.json); null if missing. */
  readProjectFile(rel: string): Promise<string | null>
  writeProjectFile(rel: string, text: string): Promise<void>
  /** Delete app data under .texdesk/ (refused anywhere else). */
  deleteAppData(rel: string): Promise<void>
}
