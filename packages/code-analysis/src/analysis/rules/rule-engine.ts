import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

/**
 * Runs every rule against one file's context and flattens the findings.
 * Rules are expected to be deterministic and side-effect-free (see
 * AnalysisRule's doc comment) — the try/catch here is a defensive
 * backstop so one misbehaving rule can't abort analysis for an entire
 * file, not a substitute for testing each rule on its own.
 */
export function runRules(rules: readonly AnalysisRule[], context: AnalysisContext): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    try {
      findings.push(...rule.run(context));
    } catch {
      continue;
    }
  }
  return findings;
}
