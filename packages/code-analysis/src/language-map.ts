/**
 * Extension → language, used for SOURCE classification. Deliberately just
 * extension matching for Phase 3 — "do not attempt sophisticated language
 * detection yet" — structured as one flat, easy-to-extend map so Phase 4
 * (real parsing/chunking) can layer on top without restructuring this.
 */
export const LANGUAGE_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".ts", "TypeScript"],
  [".tsx", "TypeScript"],
  [".js", "JavaScript"],
  [".jsx", "JavaScript"],
  [".mjs", "JavaScript"],
  [".cjs", "JavaScript"],
  [".py", "Python"],
  [".java", "Java"],
  [".c", "C"],
  [".h", "C"],
  [".cpp", "C++"],
  [".cc", "C++"],
  [".cxx", "C++"],
  [".hpp", "C++"],
  [".go", "Go"],
  [".rs", "Rust"],
  [".rb", "Ruby"],
  [".php", "PHP"],
  [".cs", "C#"],
  [".kt", "Kotlin"],
  [".kts", "Kotlin"],
  [".swift", "Swift"],
  [".html", "HTML"],
  [".htm", "HTML"],
  [".css", "CSS"],
  [".scss", "CSS"],
  [".sass", "CSS"],
  [".less", "CSS"],
  [".sql", "SQL"],
  [".sh", "Shell"],
  [".bash", "Shell"],
  [".zsh", "Shell"],
]);

export function languageForExtension(extension: string): string | null {
  return LANGUAGE_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}
