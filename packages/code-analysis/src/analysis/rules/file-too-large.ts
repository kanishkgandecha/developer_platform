import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

export const fileTooLargeRule: AnalysisRule = {
  id: "FILE_TOO_LARGE",
  description: "Flags files whose total line count exceeds the configured threshold.",
  run(context: AnalysisContext): Finding[] {
    const { file, metrics, thresholds } = context;
    if (metrics.lineCount <= thresholds.fileTooLargeLines) return [];

    return [
      {
        ruleId: "FILE_TOO_LARGE",
        severity: metrics.lineCount > thresholds.fileTooLargeLines * 2 ? "HIGH" : "MEDIUM",
        message: `${file.path} has ${metrics.lineCount} lines, above the configured threshold of ${thresholds.fileTooLargeLines}`,
        file: file.path,
        line: null,
        column: null,
        metadata: { lineCount: metrics.lineCount, threshold: thresholds.fileTooLargeLines },
      },
    ];
  },
};
