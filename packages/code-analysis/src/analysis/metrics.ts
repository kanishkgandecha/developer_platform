import type { CodeMetrics, ParsedFile } from "./types.js";

/**
 * Per-language comment syntax, used only to classify whole lines as
 * "comment" vs "code" — never to strip trailing comments from a code line.
 * A line is counted as a comment line only when a comment token appears at
 * the very start of the trimmed line: `const x = 1; // note` counts as a
 * code line, matching how most LOC-counting tools behave, and avoiding the
 * ambiguity of trying to split a line into "real" code vs. a trailing
 * comment without a real tokenizer.
 */
interface CommentSyntax {
  line?: string;
  blockStart?: string;
  blockEnd?: string;
}

const COMMENT_SYNTAX: Readonly<Record<string, CommentSyntax>> = {
  TypeScript: { line: "//", blockStart: "/*", blockEnd: "*/" },
  JavaScript: { line: "//", blockStart: "/*", blockEnd: "*/" },
  Java: { line: "//", blockStart: "/*", blockEnd: "*/" },
  "C++": { line: "//", blockStart: "/*", blockEnd: "*/" },
  C: { line: "//", blockStart: "/*", blockEnd: "*/" },
  Go: { line: "//", blockStart: "/*", blockEnd: "*/" },
  Rust: { line: "//", blockStart: "/*", blockEnd: "*/" },
  "C#": { line: "//", blockStart: "/*", blockEnd: "*/" },
  Kotlin: { line: "//", blockStart: "/*", blockEnd: "*/" },
  Swift: { line: "//", blockStart: "/*", blockEnd: "*/" },
  Python: { line: "#" },
  Ruby: { line: "#" },
  Shell: { line: "#" },
  SQL: { line: "--" },
};

interface LineMetrics {
  lineCount: number;
  codeLineCount: number;
  commentLineCount: number;
  blankLineCount: number;
}

export function computeLineMetrics(content: string, language: string): LineMetrics {
  const lines = content.split(/\r\n|\r|\n/);
  const syntax = COMMENT_SYNTAX[language];

  let commentLineCount = 0;
  let blankLineCount = 0;
  let inBlockComment = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line === "") {
      blankLineCount += 1;
      continue;
    }

    if (!syntax) continue; // unknown/unsupported language — every non-blank line counts as code

    if (inBlockComment) {
      commentLineCount += 1;
      if (syntax.blockEnd && line.includes(syntax.blockEnd)) inBlockComment = false;
      continue;
    }

    if (syntax.blockStart && line.startsWith(syntax.blockStart)) {
      commentLineCount += 1;
      const rest = line.slice(syntax.blockStart.length);
      inBlockComment = !(syntax.blockEnd && rest.includes(syntax.blockEnd));
      continue;
    }

    if (syntax.line && line.startsWith(syntax.line)) {
      commentLineCount += 1;
    }
  }

  const lineCount = lines.length;
  return {
    lineCount,
    commentLineCount,
    blankLineCount,
    codeLineCount: lineCount - commentLineCount - blankLineCount,
  };
}

/**
 * Combines line-based metrics with symbol-derived counts. `complexity` is
 * only summed for AST-parsed files (`parseStrategy === "ast"`) — `null`
 * everywhere else, never estimated for heuristically-parsed languages.
 */
export function computeMetrics(content: string, file: ParsedFile): CodeMetrics {
  const lineMetrics = computeLineMetrics(content, file.language);

  const functionCount = file.symbols.filter((s) => s.kind === "FUNCTION" || s.kind === "METHOD").length;
  const classCount = file.symbols.filter((s) => s.kind === "CLASS" || s.kind === "INTERFACE").length;
  const importCount = file.imports.length;
  const exportCount = file.symbols.filter((s) => s.exported).length;

  const complexity =
    file.parseStrategy === "ast"
      ? file.symbols.reduce((sum, s) => sum + (s.complexity ?? 0), 0)
      : null;

  return {
    ...lineMetrics,
    functionCount,
    classCount,
    importCount,
    exportCount,
    complexity,
  };
}
