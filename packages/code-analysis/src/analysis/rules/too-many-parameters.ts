import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

export const tooManyParametersRule: AnalysisRule = {
  id: "TOO_MANY_PARAMETERS",
  description: "Flags functions/methods with more parameters than the configured threshold.",
  run(context: AnalysisContext): Finding[] {
    const { file, thresholds } = context;
    const findings: Finding[] = [];

    for (const sym of file.symbols) {
      if ((sym.kind !== "FUNCTION" && sym.kind !== "METHOD") || sym.parameterCount === null) continue;
      if (sym.parameterCount <= thresholds.tooManyParameters) continue;

      findings.push({
        ruleId: "TOO_MANY_PARAMETERS",
        severity: "LOW",
        message: `${sym.name} has ${sym.parameterCount} parameters, above the configured threshold of ${thresholds.tooManyParameters}`,
        file: file.path,
        line: sym.startLine,
        column: null,
        metadata: { symbol: sym.name, parameterCount: sym.parameterCount, threshold: thresholds.tooManyParameters },
      });
    }

    return findings;
  },
};
