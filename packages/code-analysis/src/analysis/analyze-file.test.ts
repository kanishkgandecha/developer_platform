import { describe, expect, it } from "vitest";
import { analyzeFile } from "./analyze-file.js";

describe("analyzeFile", () => {
  it("parses, computes metrics, and runs rules for a TypeScript file in one call", () => {
    const result = analyzeFile("a.ts", `export function f() { return 1; } // TODO: revisit`, "TypeScript");
    expect(result.parsed.parseStrategy).toBe("ast");
    expect(result.metrics.functionCount).toBe(1);
    expect(result.findings.some((f) => f.ruleId === "TODO_COMMENT")).toBe(true);
  });

  it("dispatches to the heuristic parser for Python", () => {
    const result = analyzeFile("a.py", `def f():\n    pass\n`, "Python");
    expect(result.parsed.parseStrategy).toBe("heuristic");
    expect(result.metrics.complexity).toBeNull();
  });

  it("produces empty symbols/imports and parseStrategy 'none' for a language with no parser", () => {
    const result = analyzeFile("a.rb", `def f\nend\n`, "Ruby");
    expect(result.parsed.parseStrategy).toBe("none");
    expect(result.parsed.symbols).toEqual([]);
  });

  it("handles a null language the same as an unparseable one", () => {
    const result = analyzeFile("a.bin", "binary-ish content", null);
    expect(result.parsed.parseStrategy).toBe("none");
    expect(result.metrics.lineCount).toBe(1);
  });
});
