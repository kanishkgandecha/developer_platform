import { describe, expect, it } from "vitest";
import { computeLineMetrics, computeMetrics } from "./metrics.js";
import { parseTypeScript } from "./typescript-parser.js";

describe("computeLineMetrics", () => {
  it("counts code, comment, and blank lines for a // and block-comment language", () => {
    const content = [
      "// header comment",
      "const x = 1;",
      "",
      "/* block",
      " * continues",
      " */",
      "const y = 2;",
    ].join("\n");

    const metrics = computeLineMetrics(content, "TypeScript");
    expect(metrics).toEqual({ lineCount: 7, codeLineCount: 2, commentLineCount: 4, blankLineCount: 1 });
  });

  it("counts a single-line block comment as one comment line", () => {
    const metrics = computeLineMetrics("/* one line */\nconst x = 1;", "TypeScript");
    expect(metrics.commentLineCount).toBe(1);
    expect(metrics.codeLineCount).toBe(1);
  });

  it("does not treat a trailing inline comment as a comment line", () => {
    const metrics = computeLineMetrics("const x = 1; // trailing", "TypeScript");
    expect(metrics).toEqual({ lineCount: 1, codeLineCount: 1, commentLineCount: 0, blankLineCount: 0 });
  });

  it("uses # for Python", () => {
    const metrics = computeLineMetrics("# comment\nx = 1", "Python");
    expect(metrics.commentLineCount).toBe(1);
    expect(metrics.codeLineCount).toBe(1);
  });

  it("treats every non-blank line as code for a language with no known comment syntax", () => {
    const metrics = computeLineMetrics("some line\nanother", "Unknown");
    expect(metrics).toEqual({ lineCount: 2, codeLineCount: 2, commentLineCount: 0, blankLineCount: 0 });
  });
});

describe("computeMetrics", () => {
  it("derives function/class/import/export counts and a summed complexity from a parsed AST file", () => {
    const content = `import { readFile } from "node:fs";

export class Service {
  run() {
    if (true) return 1;
    return 0;
  }
}

export function helper() {
  return 1;
}
`;
    const parsed = parseTypeScript("src/service.ts", content);
    const metrics = computeMetrics(content, parsed);

    expect(metrics.functionCount).toBe(2); // run() + helper()
    expect(metrics.classCount).toBe(1);
    expect(metrics.importCount).toBe(1);
    expect(metrics.exportCount).toBe(2); // Service + helper (run() isn't independently exported)
    expect(metrics.complexity).toBe(3); // run() = 2, helper() = 1
  });

  it("never computes complexity for a heuristically-parsed file", () => {
    const parsed = { path: "a.py", language: "Python", parseStrategy: "heuristic" as const, symbols: [], imports: [] };
    const metrics = computeMetrics("x = 1\n", parsed);
    expect(metrics.complexity).toBeNull();
  });
});
