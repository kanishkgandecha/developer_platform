import type { AIProvider } from "../chat/types.js";
import { AGENT_SYSTEM_GUARDRAILS } from "./guardrails.js";
import { AgentOutputSchema, type AgentOutput } from "./schemas.js";
import type { AgentEvidence, AgentSpec } from "./types.js";

function buildSystemPrompt(spec: AgentSpec): string {
  const lines = [AGENT_SYSTEM_GUARDRAILS, "", `You are specifically the ${spec.title}.`, spec.focus, "", "Specifically analyze:"];
  for (const instruction of spec.instructions) {
    lines.push(`- ${instruction}`);
  }
  if (spec.severityGuidance) {
    lines.push("", spec.severityGuidance);
  }
  return lines.join("\n");
}

function formatEvidence(evidence: AgentEvidence): string {
  const lines: string[] = [];
  lines.push(`Repository: ${evidence.repository.fullName}${evidence.repository.description ? ` — ${evidence.repository.description}` : ""}`);
  lines.push(`Default branch: ${evidence.repository.defaultBranch}`);
  lines.push("");
  lines.push("## Deterministic analysis summary (Phase 4 — real, measured data, not an estimate)");
  lines.push(`Files analyzed: ${evidence.deterministic.filesAnalyzed}`);
  lines.push(`Symbols found: ${evidence.deterministic.symbolsFound}`);
  lines.push(`Imports found: ${evidence.deterministic.importsFound}`);
  lines.push(
    `Total deterministic findings: ${evidence.deterministic.findingsCount} ` +
      `(CRITICAL ${evidence.deterministic.severityCounts.CRITICAL}, HIGH ${evidence.deterministic.severityCounts.HIGH}, ` +
      `MEDIUM ${evidence.deterministic.severityCounts.MEDIUM}, LOW ${evidence.deterministic.severityCounts.LOW}, ` +
      `INFO ${evidence.deterministic.severityCounts.INFO})`,
  );

  if (evidence.deterministic.largestFiles.length > 0) {
    lines.push("", "Largest/most complex files:");
    for (const file of evidence.deterministic.largestFiles) {
      lines.push(`- ${file.filePath}: ${file.lineCount} lines${file.complexity !== null ? `, complexity ${file.complexity}` : ""}`);
    }
  }

  if (evidence.deterministic.relevantFindings.length > 0) {
    lines.push("", "Relevant deterministic findings:");
    for (const finding of evidence.deterministic.relevantFindings) {
      const location = finding.filePath ? ` (${finding.filePath}${finding.line !== null ? `:${finding.line}` : ""})` : "";
      lines.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.message}${location}`);
    }
  } else {
    lines.push("", "No relevant deterministic findings for this agent's focus area.");
  }

  lines.push("", "## Retrieved source code evidence (semantic + lexical search, scoped to this agent's focus area)");
  if (evidence.ragContext.chunks.length === 0) {
    lines.push("(no relevant chunks were retrieved)");
  }
  for (const chunk of evidence.ragContext.chunks) {
    lines.push("", `### ${chunk.citation}${chunk.symbolName ? ` — ${chunk.symbolName}` : ""}`, "```", chunk.content, "```");
  }

  return lines.join("\n");
}

/**
 * Runs one primary agent: builds its system prompt (guardrails + this
 * agent's specific focus/instructions) and user prompt (the bounded
 * evidence, formatted as readable Markdown-ish text — never repository
 * content masquerading as an instruction; see guardrails.ts), then asks
 * the provider for a schema-validated `AgentOutput`.
 *
 * A single function shared by all six primary agents (each parameterized
 * by its own `AgentSpec`), not seven independently-implemented modules —
 * the "specialization" lives in the spec data (title, focus, instructions,
 * retrieval query, relevant rule ids), the same "registry of definitions,
 * not a class hierarchy" pattern
 * packages/code-analysis/src/analysis/rules uses for Phase 4's rule
 * engine. This also means every agent is tested identically (supply a
 * spec + an evidence fixture + a mock provider), not with seven
 * near-duplicate test files.
 */
export async function runAgent(spec: AgentSpec, evidence: AgentEvidence, provider: AIProvider): Promise<AgentOutput> {
  return provider.generateStructured({
    systemPrompt: buildSystemPrompt(spec),
    userPrompt: formatEvidence(evidence),
    schema: AgentOutputSchema,
    schemaName: `${spec.type.toLowerCase()}_agent_output`,
  });
}
