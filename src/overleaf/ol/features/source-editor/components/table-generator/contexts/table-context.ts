// The one type LaTeXDesk needs from Overleaf's React table context
export type TableEnvironmentData = {
  table: { from: number; to: number }
  caption?: { from: number; to: number }
  label?: { from: number; to: number }
}
