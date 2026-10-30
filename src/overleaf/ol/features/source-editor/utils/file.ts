// LaTeXDesk: the one file helper the visual editor uses
export const getFileExtension = (filename: string): string | null => {
  const parts = filename.split('.')
  if (parts.length < 2) {
    return null
  }
  return parts[parts.length - 1].toLowerCase()
}
