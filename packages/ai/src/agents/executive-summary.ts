import type { AIProvider } from "../chat/types.js";
import { AGENT_SYSTEM_GUARDRAILS } from "./guardrails.js";
import { ExecutiveSummaryOutputSchema, type ExecutiveSummaryOutput } from "./schemas.js";
import type { AgentRunResult } from "./types.js";

const EXECUTIVE_SUMMARY_SCHEMA_NAME = "executive_summary_agent_output";
export const EXECUTIVE_SUMMARY_TITLE = "Executive Summary Agent";

/** Bounds how many of each primary agent's findings are included in the executive summary's own context — the agent's own `summary` field already condenses the rest. */
const MAX_FINDINGS_PER_AGENT_IN_SUMMARY = 5;

const EXECUTIVE_SUMMARY_SYSTEM_PROMPT = [
  AGENT_SYSTEM_GUARDRAILS,
  "",
  `You are specifically the ${EXECUTIVE_SUMMARY_TITLE}.`,
  "You produce a high-level engineering summary of this repository by synthesizing the six specialized agents' already-completed analyses below — you do not have your own access to the repository's source code or retrieval evidence, only what those six agents already found.",
  "",
  "Specifically:",
  "- Summarize overall repository health, referencing what the six agents actually found",
  "- Identify the strongest areas",
  "- Identify the highest-priority risks across all six agents combined, not just the most numerous",
  "- Identify technical debt, security concerns, performance concerns, and architecture concerns where the underlying agents actually raised them",
  "- Recommend concrete next steps",
  "",
  "Do not simply concatenate the six agents' summaries — synthesize them into a coherent, prioritized narrative.",
  "For `topRisks`: select the most important findings from across the six agents' own findings below, and copy each selected finding's `citations` field exactly as given — never invent a new citation for a finding you did not yourself retrieve evidence for.",
].join("\n");

function formatAgentResultsForSummary(results: readonly AgentRunResult[]): string {
  const lines: string[] = [];
  for (const { spec, output } of results) {
    lines.push(`## ${spec.title}`, output.summary);
    if (output.findings.length === 0) {
      lines.push("(no findings)");
    } else {
      lines.push("Findings:");
      for (const finding of output.findings.slice(0, MAX_FINDINGS_PER_AGENT_IN_SUMMARY)) {
        lines.push(
          `- [${finding.severity}, confidence ${finding.confidence.toFixed(2)}] ${finding.title}: ${finding.summary} — citations: ${JSON.stringify(finding.citations)}`,
        );
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Runs the executive summary agent — always after the six primary agents,
 * over their already-validated structured outputs (see
 * apps/worker/src/ai-analysis/pipeline.ts for the orchestration order).
 * `results` should only include agents that actually `COMPLETED` — a
 * caller with fewer than six results (some agents failed) still gets a
 * synthesis of whichever succeeded; the executive summary never blocks on
 * a partial run.
 */
export async function runExecutiveSummaryAgent(results: readonly AgentRunResult[], provider: AIProvider): Promise<ExecutiveSummaryOutput> {
  return provider.generateStructured({
    systemPrompt: EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
    userPrompt: formatAgentResultsForSummary(results),
    schema: ExecutiveSummaryOutputSchema,
    schemaName: EXECUTIVE_SUMMARY_SCHEMA_NAME,
  });
}
