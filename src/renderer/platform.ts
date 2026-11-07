// Install advice that depends on the operating system: Windows gets download links, Linux gets the package
// manager commands for the common distributions (Arch first: it's what Omarchy uses).
export const PLATFORM: string = (window as unknown as { texdesk: { platform?: string } }).texdesk?.platform ?? 'win32'
export const IS_LINUX = PLATFORM === 'linux'

const cmd = (s: string) => `<code>${s}</code>`

/** A full TeX distribution, for people who want one instead of the built-in engine. */
const TEXLIVE_STEPS = `${cmd('sudo pacman -S texlive texlive-binextra')} on Arch, or ${cmd('sudo apt install texlive-full')} on Ubuntu/Debian`
export const FULL_TEX = IS_LINUX
  ? {
      name: 'TeX Live',
      html: `install <b>TeX Live</b>: ${TEXLIVE_STEPS}`,
      steps: `To install it, run ${TEXLIVE_STEPS}, then restart LaTeXDesk.`,
      detail: 'A full TeX distribution from your package manager, if you need biblatex/biber or work offline a lot.',
      link: 'https://tug.org/texlive/',
    }
  : {
      name: 'MiKTeX',
      html: 'install <a href="https://miktex.org/download" target="_blank">MiKTeX</a> (free, a full distribution)',
      detail: 'A full TeX distribution (about 1 GB once packages are added), if you need biblatex/biber or work offline a lot. Choose “install missing packages on the fly: Yes”, then restart LaTeXDesk.',
      steps: '',
      link: 'https://miktex.org/download',
    }

/** Java, which LanguageTool (grammar checking) runs on. */
export const JAVA_HTML = IS_LINUX
  ? `run ${cmd('sudo pacman -S jre-openjdk')} on Arch, or ${cmd('sudo apt install default-jre')} on Ubuntu/Debian`
  : 'install <a href="https://adoptium.net/" target="_blank">Temurin</a> (free)'

/** Ollama, for local AI. */
export const OLLAMA_HTML = IS_LINUX
  ? `Install Ollama (free): ${cmd('sudo pacman -S ollama')} on Arch (${cmd('ollama-cuda')} for NVIDIA, ${cmd('ollama-rocm')} for AMD), then ${cmd('sudo systemctl enable --now ollama')}; other distributions: <a href="https://ollama.com/download/linux" target="_blank">ollama.com</a>`
  : 'Install <a href="https://ollama.com/download" target="_blank">Ollama</a> (free)'

/** Zotero. */
export const ZOTERO_HTML = IS_LINUX
  ? '<a href="https://www.zotero.org/download/" target="_blank">Zotero</a> (on Arch: the AUR package <code>zotero-bin</code>, or the Flatpak)'
  : '<a href="https://www.zotero.org/download/" target="_blank">Zotero</a>'
