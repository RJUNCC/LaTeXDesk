// LaTeXDesk: typings for importing the Emscripten module from TypeScript (see hunspell.d.ts for the API)
declare const Hunspell: (opts: { locateFile(file: string): string }) => Promise<any>
export default Hunspell
