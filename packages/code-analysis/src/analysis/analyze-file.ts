import { computeMetrics } from "./metrics.js";
import { parseFile } from "./parse-file.js";
import { DEFAULT_RULES, runRules } from "./rules/index.js";
import type { CodeMetrics, Finding, ParsedFile, RuleThresholds } from "./types.js";
import { DEFAULT_RULE_THRESHOLDS } from "./types.js";

export interface FileAnalysisResult {
  parsed: ParsedFile;
  metrics: CodeMetrics;
  findings: Finding[];
}

/**
 * The single entry point apps/worker's analysis pipeline calls per file:
 * parse → compute metrics → run the deterministic rule engine. Everything
 * here is pure and synchronous — no I/O, no network, no repository code
 * ever executed (parsing means building/walking a syntax tree or matching
 * text, never `eval`-ing or requiring the file).
 */
export function analyzeFile(
  path: string,
  content: string,
  language: string | null,
  thresholds: RuleThresholds = DEFAULT_RULE_THRESHOLDS,
): FileAnalysisResult {
  const parsed = parseFile(path, content, language);
  const metrics = computeMetrics(content, parsed);
  const findings = runRules(DEFAULT_RULES, { file: parsed, metrics, content, thresholds });

  return { parsed, metrics, findings };
}
