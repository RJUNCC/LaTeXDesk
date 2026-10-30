// Visual mode: Overleaf's visual (rich-text) editor, ported in src/overleaf/ol. The same .tex file is shown as
// a formatted document (headings, bold, lists, rendered maths, figures, tables) and stays real LaTeX
// underneath, so switching between Code and Visual never changes the file.
import { EditorState, Extension } from '@codemirror/state'
import { ViewPlugin } from '@codemirror/view'
import { filePreview } from '@/features/source-editor/extensions/file-preview'

export { visual, setVisual, isVisual, sourceOnly } from '@/features/source-editor/extensions/visual/visual'

const IMAGE_EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp']

/** Files only Code mode makes sense for (preamble packages, bibliographies, …) */
export const visualCapable = (path: string) => /\.tex$/i.test(path)

/**
 * \includegraphics{figures/plot} → a URL the main process serves from the open project (ldfile://project/…).
 * LaTeX allows leaving off the extension, so try the usual image types like pdflatex does.
 */
export function projectImages(files: () => { path: string }[]): Extension {
  return filePreview(raw => {
    const want = raw.trim().replace(/^\.\//, '').replace(/\\/g, '/')
    const paths = new Set(files().map(f => f.path))
    const candidates = /\.[a-z0-9]+$/i.test(want) ? [want] : IMAGE_EXTENSIONS.map(ext => `${want}.${ext}`)
    const found = candidates.find(c => paths.has(c))
    if (!found) return null
    return { url: `ldfile://project/${encodeURIComponent(found)}`, extension: found.split('.').pop()!.toLowerCase() }
  })
}

/** English text for the interface phrases Overleaf's visual editor looks up by key. */
export const visualPhrases = EditorState.phrases.of({
  show_document_preamble: 'Show document preamble',
  hide_document_preamble: 'Hide document preamble',
  expand: 'Expand',
  end_of_document: 'End of document',
  learn_more: 'Learn more',
  click_recompile_and_check_your_pdf_to_see_how_its_looking: 'Recompile and check the PDF to see how it looks.',
  the_visual_editor_cant_preview_this_type_of_image_file: 'The visual editor can’t preview this type of image file.',
  sorry_your_table_cant_be_displayed_at_the_moment: 'This table can’t be shown visually.',
  this_could_be_because_we_cant_support_some_elements_of_the_table: 'It uses something the visual table view doesn’t support. Switch to Code to edit it.',
})

/** Overleaf's visual theme sizes its page from --content-width, which their editor sets on resize. */
export const contentWidth = ViewPlugin.define(view => {
  const set = () => view.dom.style.setProperty('--content-width', `${view.scrollDOM.clientWidth}px`)
  const observer = new ResizeObserver(set)
  observer.observe(view.scrollDOM)
  set()
  return { destroy: () => observer.disconnect() }
})
