import { describe, expect, it } from "vitest";
import { computeMetrics } from "../metrics.js";
import { parseTypeScript } from "../typescript-parser.js";
import type { AnalysisContext, RuleThresholds } from "../types.js";
import { DEFAULT_RULE_THRESHOLDS } from "../types.js";
import { complexityHighRule } from "./complexity-high.js";
import { fileTooLargeRule } from "./file-too-large.js";
import { functionTooLongRule } from "./function-too-long.js";
import { runRules } from "./rule-engine.js";
import { todoCommentRule } from "./todo-comment.js";
import { tooManyParametersRule } from "./too-many-parameters.js";
import { DEFAULT_RULES } from "./index.js";

function contextFor(path: string, content: string, thresholds: RuleThresholds = DEFAULT_RULE_THRESHOLDS): AnalysisContext {
  const file = parseTypeScript(path, content);
  const metrics = computeMetrics(content, file);
  return { file, metrics, content, thresholds };
}

describe("complexityHighRule", () => {
  it("fires when a function's complexity exceeds the threshold", () => {
    const branches = Array.from({ length: 12 }, (_, i) => `if (x === ${i}) return ${i};`).join("\n  ");
    const context = contextFor("a.ts", `export function f(x: number) {\n  ${branches}\n  return -1;\n}`, {
      ...DEFAULT_RULE_THRESHOLDS,
      complexityHigh: 5,
    });
    const findings = complexityHighRule.run(context);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: "COMPLEXITY_HIGH", file: "a.ts" });
  });

  it("does not fire for a simple function (negative case)", () => {
    const context = contextFor("a.ts", `export function f() { return 1; }`);
    expect(complexityHighRule.run(context)).toEqual([]);
  });
});

describe("fileTooLargeRule", () => {
  it("fires when line count exceeds the threshold", () => {
    const content = Array.from({ length: 10 }, (_, i) => `const x${i} = ${i};`).join("\n");
    const context = contextFor("big.ts", content, { ...DEFAULT_RULE_THRESHOLDS, fileTooLargeLines: 5 });
    expect(fileTooLargeRule.run(context)).toHaveLength(1);
  });

  it("does not fire for a small file (negative case)", () => {
    const context = contextFor("small.ts", "const x = 1;");
    expect(fileTooLargeRule.run(context)).toEqual([]);
  });
});

describe("functionTooLongRule", () => {
  it("fires when a function spans more lines than the threshold", () => {
    const body = Array.from({ length: 10 }, (_, i) => `  const v${i} = ${i};`).join("\n");
    const context = contextFor("f.ts", `function f() {\n${body}\n  return 1;\n}`, {
      ...DEFAULT_RULE_THRESHOLDS,
      functionTooLongLines: 5,
    });
    expect(functionTooLongRule.run(context)).toHaveLength(1);
  });

  it("does not fire for a short function (negative case)", () => {
    const context = contextFor("f.ts", `function f() { return 1; }`);
    expect(functionTooLongRule.run(context)).toEqual([]);
  });
});

describe("tooManyParametersRule", () => {
  it("fires when a function has more parameters than the threshold", () => {
    const context = contextFor("p.ts", `function f(a: number, b: number, c: number) {}`, {
      ...DEFAULT_RULE_THRESHOLDS,
      tooManyParameters: 2,
    });
    expect(tooManyParametersRule.run(context)).toHaveLength(1);
  });

  it("does not fire when within the threshold (negative case)", () => {
    const context = contextFor("p.ts", `function f(a: number) {}`);
    expect(tooManyParametersRule.run(context)).toEqual([]);
  });
});

describe("todoCommentRule", () => {
  it("finds TODO and FIXME comments with their line numbers", () => {
    const context = contextFor("t.ts", `// TODO: fix this\nconst x = 1;\n// FIXME later`);
    const findings = todoCommentRule.run(context);
    expect(findings).toHaveLength(2);
    expect(findings[0]).toMatchObject({ ruleId: "TODO_COMMENT", line: 1 });
    expect(findings[1]).toMatchObject({ line: 3 });
  });

  it("finds nothing when there are no TODO/FIXME markers (negative case)", () => {
    const context = contextFor("t.ts", `const x = 1;`);
    expect(todoCommentRule.run(context)).toEqual([]);
  });
});

describe("runRules", () => {
  it("aggregates findings from every rule and survives one rule throwing", () => {
    const context = contextFor("a.ts", `const x = 1; // TODO clean up`);
    const throwingRule = { id: "BROKEN", description: "always throws", run: () => { throw new Error("boom"); } };
    const findings = runRules([...DEFAULT_RULES, throwingRule], context);
    expect(findings.some((f) => f.ruleId === "TODO_COMMENT")).toBe(true);
  });
});
