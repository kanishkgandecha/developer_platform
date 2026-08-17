import type { AnalysisContext, AnalysisRule, Finding } from "../types.js";

const TODO_FIXME_RE = /\b(TODO|FIXME)\b:?\s*(.*)/;

/**
 * Scans every line for the literal tokens `TODO`/`FIXME`, not only inside
 * already-detected comments — simplest, most reliable option, works
 * regardless of a language's comment syntax (or lack of one in
 * metrics.ts's table), at the cost of an occasional false positive inside
 * a string literal. Matches how most simple TODO-scanning linters behave.
 */
export const todoCommentRule: AnalysisRule = {
  id: "TODO_COMMENT",
  description: "Flags TODO/FIXME comments left in source.",
  run(context: AnalysisContext): Finding[] {
    const findings: Finding[] = [];
    const lines = context.content.split(/\r\n|\r|\n/);

    lines.forEach((line, index) => {
      const match = TODO_FIXME_RE.exec(line);
      if (!match) return;

      const marker = match[1];
      const detail = match[2]?.trim() || line.trim();
      findings.push({
        ruleId: "TODO_COMMENT",
        severity: "INFO",
        message: `${marker} comment: ${detail}`.slice(0, 240),
        file: context.file.path,
        line: index + 1,
        column: null,
        metadata: { marker },
      });
    });

    return findings;
  },
};
