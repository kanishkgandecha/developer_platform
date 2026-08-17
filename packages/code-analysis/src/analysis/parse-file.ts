import { isHeuristicLanguage, parseHeuristic } from "./heuristic-parser.js";
import { parseTypeScript } from "./typescript-parser.js";
import type { ParsedFile } from "./types.js";

const AST_LANGUAGES: ReadonlySet<string> = new Set(["TypeScript", "JavaScript"]);

/** Dispatches to the right parser (or none) based on the file's already-classified language — see docs/code-intelligence.md's language support table. */
export function parseFile(path: string, content: string, language: string | null): ParsedFile {
  if (language && AST_LANGUAGES.has(language)) {
    return parseTypeScript(path, content);
  }
  if (language && isHeuristicLanguage(language)) {
    return parseHeuristic(path, content, language);
  }
  return { path, language: language ?? "Unknown", parseStrategy: "none", symbols: [], imports: [] };
}
