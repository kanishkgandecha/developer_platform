import { describe, expect, it } from "vitest";
import { PRIMARY_AGENT_SPECS } from "./specs.js";

describe("PRIMARY_AGENT_SPECS", () => {
  it("defines exactly six primary agents", () => {
    expect(PRIMARY_AGENT_SPECS).toHaveLength(6);
  });

  it("gives every agent a unique type", () => {
    const types = PRIMARY_AGENT_SPECS.map((spec) => spec.type);
    expect(new Set(types).size).toBe(6);
  });

  it("matches the six expected agent types, in spec order", () => {
    expect(PRIMARY_AGENT_SPECS.map((s) => s.type)).toEqual([
      "ARCHITECTURE",
      "CODE_QUALITY",
      "SECURITY",
      "PERFORMANCE",
      "DEPENDENCY_RISK",
      "DOCUMENTATION",
    ]);
  });

  it("gives every agent a title, focus, non-empty instructions, and a retrieval query", () => {
    for (const spec of PRIMARY_AGENT_SPECS) {
      expect(spec.title.length).toBeGreaterThan(0);
      expect(spec.focus.length).toBeGreaterThan(0);
      expect(spec.instructions.length).toBeGreaterThan(0);
      expect(spec.retrievalQuery.length).toBeGreaterThan(0);
    }
  });

  it("scopes the Code Quality agent to Phase 4's deterministic quality rules", () => {
    const codeQuality = PRIMARY_AGENT_SPECS.find((s) => s.type === "CODE_QUALITY")!;
    expect(codeQuality.relevantRuleIds).toEqual(
      expect.arrayContaining(["COMPLEXITY_HIGH", "FILE_TOO_LARGE", "FUNCTION_TOO_LONG", "TOO_MANY_PARAMETERS", "TODO_COMMENT"]),
    );
  });

  it("gives the Security and Performance agents explicit severity/confidence calibration guidance", () => {
    const security = PRIMARY_AGENT_SPECS.find((s) => s.type === "SECURITY")!;
    const performance = PRIMARY_AGENT_SPECS.find((s) => s.type === "PERFORMANCE")!;
    expect(security.severityGuidance).toMatch(/exploitable/i);
    expect(performance.severityGuidance).toMatch(/measured|benchmark/i);
  });
});
