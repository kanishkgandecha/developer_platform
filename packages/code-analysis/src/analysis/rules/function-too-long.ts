import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

export const functionTooLongRule: AnalysisRule = {
  id: "FUNCTION_TOO_LONG",
  description: "Flags functions/methods whose line span exceeds the configured threshold.",
  run(context: AnalysisContext): Finding[] {
    const { file, thresholds } = context;
    const findings: Finding[] = [];

    for (const sym of file.symbols) {
      if (sym.kind !== "FUNCTION" && sym.kind !== "METHOD") continue;
      const length = sym.endLine - sym.startLine + 1;
      if (length <= thresholds.functionTooLongLines) continue;

      findings.push({
        ruleId: "FUNCTION_TOO_LONG",
        severity: length > thresholds.functionTooLongLines * 2 ? "HIGH" : "MEDIUM",
        message: `${sym.name} spans ${length} lines, above the configured threshold of ${thresholds.functionTooLongLines}`,
        file: file.path,
        line: sym.startLine,
        column: null,
        metadata: { symbol: sym.name, length, threshold: thresholds.functionTooLongLines },
      });
    }

    return findings;
  },
};
