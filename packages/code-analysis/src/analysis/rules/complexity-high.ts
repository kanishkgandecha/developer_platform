import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

/** Only fires for AST-parsed (TypeScript/JavaScript) symbols — complexity is never estimated for heuristically-parsed languages, see typescript-parser.ts. */
export const complexityHighRule: AnalysisRule = {
  id: "COMPLEXITY_HIGH",
  description: "Flags functions/methods whose cyclomatic complexity exceeds the configured threshold.",
  run(context: AnalysisContext): Finding[] {
    const { file, thresholds } = context;
    const findings: Finding[] = [];

    for (const sym of file.symbols) {
      if ((sym.kind !== "FUNCTION" && sym.kind !== "METHOD") || sym.complexity === null) continue;
      if (sym.complexity <= thresholds.complexityHigh) continue;

      findings.push({
        ruleId: "COMPLEXITY_HIGH",
        severity: sym.complexity > thresholds.complexityHigh * 2 ? "HIGH" : "MEDIUM",
        message: `${sym.name} has a cyclomatic complexity of ${sym.complexity}, above the configured threshold of ${thresholds.complexityHigh}`,
        file: file.path,
        line: sym.startLine,
        column: null,
        metadata: { symbol: sym.name, complexity: sym.complexity, threshold: thresholds.complexityHigh },
      });
    }

    return findings;
  },
};
