import type { ParsedFile, ParsedImport, ParsedSymbol, SymbolKind } from "./types.js";

/**
 * Regex/line-based structural extraction for Python, Java, C++/C, and Go —
 * deliberately NOT a real parser or AST. This is the documented Phase 4
 * fallback ("if full parsing for every language cannot be implemented
 * cleanly... make other languages metadata-only") for the four languages
 * that don't get the TypeScript compiler API's real AST
 * (typescript-parser.ts). No cyclomatic complexity is computed here —
 * `complexity` stays `null` for every symbol this module produces, since a
 * reliable complexity count needs a real parse tree, not line matching.
 *
 * Known, deliberate limitations (see docs/code-intelligence.md):
 * - Java/C++/Go function and class signatures must have their opening `{`
 *   on the same line as the signature (K&R-ish style) — Allman style
 *   (brace on its own line) isn't recognized.
 * - Multi-line parameter lists aren't recognized (parameter count and the
 *   signature string are only extracted when the whole `(...)` fits on one line).
 * - Java/C++ method/function detection is a best-effort regex over
 *   "TYPE NAME(...) {"-shaped lines; unusual formatting can be missed, and
 *   `else if (...)`-style lines are explicitly excluded to avoid the most
 *   common false positive, not all of them.
 *
 * Every regex capture group accessed with `!` below is one the matching
 * regex guarantees is populated whenever `.exec()` returns non-null (no
 * optional `(...)?` groups are read this way) — `noUncheckedIndexedAccess`
 * just can't express that statically.
 */

const HEURISTIC_LANGUAGES: ReadonlySet<string> = new Set(["Python", "Java", "C++", "C", "Go"]);

export function isHeuristicLanguage(language: string): boolean {
  return HEURISTIC_LANGUAGES.has(language);
}

interface ExtractionResult {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
}

function symbol(
  name: string,
  kind: SymbolKind,
  startLine: number,
  endLine: number,
  opts: { exported?: boolean; parentName?: string | null; signature?: string | null; parameterCount?: number | null } = {},
): ParsedSymbol {
  return {
    name,
    kind,
    startLine,
    endLine,
    exported: opts.exported ?? true,
    parentName: opts.parentName ?? null,
    signature: opts.signature ?? null,
    complexity: null,
    parameterCount: opts.parameterCount ?? null,
  };
}

function extractParamCount(signatureFragment: string): number | null {
  const match = /\(([^)]*)\)/.exec(signatureFragment);
  if (!match) return null;
  const inner = (match[1] ?? "").trim();
  return inner === "" ? 0 : inner.split(",").filter((p) => p.trim() !== "").length;
}

/** Brace-balance scan starting at `startIndex` — returns the index of the line where the block closes. */
function findBraceBlockEnd(lines: readonly string[], startIndex: number): number {
  let depth = 0;
  let openedAtLeastOnce = false;
  for (let i = startIndex; i < lines.length; i++) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") {
        depth += 1;
        openedAtLeastOnce = true;
      } else if (ch === "}") {
        depth -= 1;
      }
    }
    if (openedAtLeastOnce && depth <= 0) return i;
  }
  return lines.length - 1;
}

/** Indentation-based scan (Python) — the block ends at the last contiguous line indented deeper than `baseIndent`. */
function findIndentBlockEnd(lines: readonly string[], startIndex: number, baseIndent: number): number {
  let last = startIndex;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;
    if (indent > baseIndent) {
      last = i;
    } else {
      break;
    }
  }
  return last;
}

/** A stack of "currently open" brace-delimited scopes, keyed by the line index each one closes on — used to attach a parentName to nested functions/methods without tracking a running brace depth for the whole file. */
interface ScopeFrame {
  name: string;
  endIndex: number;
}

function currentParent(stack: ScopeFrame[], lineIndex: number): string | null {
  while (stack.length > 0 && (stack.at(-1)?.endIndex ?? -1) < lineIndex) {
    stack.pop();
  }
  return stack.at(-1)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;
const PYTHON_DEF_RE = /^(\s*)def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/;
const PYTHON_FROM_IMPORT_RE = /^\s*from\s+([\w.]+)\s+import\b/;
const PYTHON_IMPORT_RE = /^\s*import\s+(.+)$/;

function extractPython(lines: string[]): ExtractionResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const classStack: { indent: number; name: string }[] = [];

  lines.forEach((line, index) => {
    const classMatch = PYTHON_CLASS_RE.exec(line);
    if (classMatch) {
      const indent = classMatch[1]!.length;
      while (classStack.length > 0 && (classStack.at(-1)?.indent ?? -1) >= indent) classStack.pop();
      const name = classMatch[2]!;
      const endIndex = findIndentBlockEnd(lines, index, indent);
      symbols.push(
        symbol(name, "CLASS", index + 1, endIndex + 1, {
          parentName: classStack.at(-1)?.name ?? null,
          signature: `class ${name}`,
        }),
      );
      classStack.push({ indent, name });
      return;
    }

    const defMatch = PYTHON_DEF_RE.exec(line);
    if (defMatch) {
      const indent = defMatch[1]!.length;
      while (classStack.length > 0 && (classStack.at(-1)?.indent ?? -1) >= indent) classStack.pop();
      const parent = classStack.at(-1)?.name ?? null;
      const name = defMatch[2]!;
      const endIndex = findIndentBlockEnd(lines, index, indent);
      const rawParamCount = extractParamCount(line);
      // Drop the implicit `self`/`cls` first parameter for methods.
      const parameterCount = parent && rawParamCount !== null ? Math.max(0, rawParamCount - 1) : rawParamCount;
      symbols.push(
        symbol(name, parent ? "METHOD" : "FUNCTION", index + 1, endIndex + 1, {
          exported: !name.startsWith("_"),
          parentName: parent,
          signature: `def ${name}(${defMatch[3]!.trim()})`,
          parameterCount,
        }),
      );
      return;
    }

    const fromImportMatch = PYTHON_FROM_IMPORT_RE.exec(line);
    if (fromImportMatch) {
      imports.push({ source: fromImportMatch[1]!, kind: "IMPORT", line: index + 1 });
      return;
    }

    const importMatch = PYTHON_IMPORT_RE.exec(line);
    if (importMatch) {
      for (const raw of importMatch[1]!.split(",")) {
        const mod = raw.trim().split(/\s+as\s+/)[0]?.trim();
        if (mod) imports.push({ source: mod, kind: "IMPORT", line: index + 1 });
      }
    }
  });

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "else",
  "for",
  "while",
  "switch",
  "catch",
  "try",
  "do",
  "synchronized",
  "return",
  "new",
  "throw",
]);

const JAVA_CLASS_RE = /^\s*(?:public|private|protected|static|final|abstract|\s)*class\s+(\w+)/;
const JAVA_INTERFACE_RE = /^\s*(?:public|private|protected|\s)*interface\s+(\w+)/;
const JAVA_METHOD_RE =
  /^\s*(?:public|private|protected|static|final|synchronized|abstract|native|\s)*[\w<>[\],.]+\s+(\w+)\s*\(([^;{)]*)\)\s*(?:throws\s+[\w,\s]+)?\{/;
const JAVA_IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;

function extractJava(lines: string[]): ExtractionResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const stack: ScopeFrame[] = [];

  lines.forEach((line, index) => {
    const parent = currentParent(stack, index);

    const importMatch = JAVA_IMPORT_RE.exec(line);
    if (importMatch) {
      imports.push({ source: importMatch[1]!, kind: "IMPORT", line: index + 1 });
      return;
    }

    const interfaceMatch = JAVA_INTERFACE_RE.exec(line);
    const classMatch = interfaceMatch ?? JAVA_CLASS_RE.exec(line);
    if (classMatch) {
      const name = classMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      const kind: SymbolKind = interfaceMatch ? "INTERFACE" : "CLASS";
      symbols.push(
        symbol(name, kind, index + 1, endIndex + 1, {
          parentName: parent,
          signature: `${kind === "INTERFACE" ? "interface" : "class"} ${name}`,
        }),
      );
      stack.push({ name, endIndex });
      return;
    }

    const methodMatch = JAVA_METHOD_RE.exec(line);
    if (methodMatch && parent && !CONTROL_KEYWORDS.has(methodMatch[1]!)) {
      const name = methodMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      symbols.push(
        symbol(name, "METHOD", index + 1, endIndex + 1, {
          exported: !line.includes("private"),
          parentName: parent,
          signature: `${name}(${methodMatch[2]!.trim()})`,
          parameterCount: extractParamCount(line),
        }),
      );
    }
  });

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// C / C++
// ---------------------------------------------------------------------------

const CPP_INCLUDE_RE = /^\s*#include\s*[<"]([^>"]+)[>"]/;
const CPP_CLASS_RE = /^\s*class\s+(\w+)/;
const CPP_FUNCTION_RE = /^[\w:<>*&,\s]+[\s*&](\w+)\s*\(([^;{)]*)\)\s*(?:const\s*)?\{/;

function extractCpp(lines: string[]): ExtractionResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const stack: ScopeFrame[] = [];

  lines.forEach((line, index) => {
    const parent = currentParent(stack, index);

    const includeMatch = CPP_INCLUDE_RE.exec(line);
    if (includeMatch) {
      imports.push({ source: includeMatch[1]!, kind: "INCLUDE", line: index + 1 });
      return;
    }

    const classMatch = CPP_CLASS_RE.exec(line);
    if (classMatch) {
      const name = classMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      symbols.push(symbol(name, "CLASS", index + 1, endIndex + 1, { parentName: parent, signature: `class ${name}` }));
      stack.push({ name, endIndex });
      return;
    }

    const functionMatch = CPP_FUNCTION_RE.exec(line);
    if (functionMatch && !CONTROL_KEYWORDS.has(functionMatch[1]!)) {
      const name = functionMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      symbols.push(
        symbol(name, parent ? "METHOD" : "FUNCTION", index + 1, endIndex + 1, {
          parentName: parent,
          signature: `${name}(${functionMatch[2]!.trim()})`,
          parameterCount: extractParamCount(line),
        }),
      );
    }
  });

  return { symbols, imports };
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const GO_FUNC_RE = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(([^)]*)\)[^{]*\{/;
const GO_STRUCT_RE = /^type\s+(\w+)\s+struct\s*\{/;
const GO_IMPORT_SINGLE_RE = /^import\s+"([^"]+)"/;
const GO_IMPORT_BLOCK_START_RE = /^import\s*\(/;

function extractGo(lines: string[]): ExtractionResult {
  const symbols: ParsedSymbol[] = [];
  const imports: ParsedImport[] = [];
  const stack: ScopeFrame[] = [];
  let inImportBlock = false;

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();

    if (inImportBlock) {
      if (line === ")") {
        inImportBlock = false;
        return;
      }
      const quoted = /"([^"]+)"/.exec(line);
      if (quoted) imports.push({ source: quoted[1]!, kind: "IMPORT", line: index + 1 });
      return;
    }

    if (GO_IMPORT_BLOCK_START_RE.test(line)) {
      inImportBlock = true;
      return;
    }

    const singleImportMatch = GO_IMPORT_SINGLE_RE.exec(line);
    if (singleImportMatch) {
      imports.push({ source: singleImportMatch[1]!, kind: "IMPORT", line: index + 1 });
      return;
    }

    const parent = currentParent(stack, index);

    const structMatch = GO_STRUCT_RE.exec(line);
    if (structMatch) {
      const name = structMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      symbols.push(
        symbol(name, "CLASS", index + 1, endIndex + 1, {
          exported: /^[A-Z]/.test(name),
          parentName: parent,
          signature: `type ${name} struct`,
        }),
      );
      stack.push({ name, endIndex });
      return;
    }

    const funcMatch = GO_FUNC_RE.exec(line);
    if (funcMatch) {
      const name = funcMatch[1]!;
      const endIndex = findBraceBlockEnd(lines, index);
      symbols.push(
        symbol(name, "FUNCTION", index + 1, endIndex + 1, {
          exported: /^[A-Z]/.test(name),
          parentName: parent,
          signature: `func ${name}(${funcMatch[2]!.trim()})`,
          parameterCount: extractParamCount(line),
        }),
      );
    }
  });

  return { symbols, imports };
}

export function parseHeuristic(path: string, content: string, language: string): ParsedFile {
  const lines = content.split(/\r\n|\r|\n/);

  let result: ExtractionResult;
  switch (language) {
    case "Python":
      result = extractPython(lines);
      break;
    case "Java":
      result = extractJava(lines);
      break;
    case "C++":
    case "C":
      result = extractCpp(lines);
      break;
    case "Go":
      result = extractGo(lines);
      break;
    default:
      result = { symbols: [], imports: [] };
  }

  return {
    path,
    language,
    parseStrategy: "heuristic",
    symbols: result.symbols,
    imports: result.imports,
  };
}
