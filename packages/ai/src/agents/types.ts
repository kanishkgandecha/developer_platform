import type { RagContext } from "../rag/types.js";
import type { AgentOutput } from "./schemas.js";

/**
 * One deterministic (Phase 4) finding, trimmed to what a prompt actually
 * needs — not the full `FindingDto` (no need for `metadata`/`column` in a
 * prompt). Built by apps/worker's evidence-gathering step from real
 * `Finding` rows, never invented.
 */
export interface DeterministicFindingEvidence {
  ruleId: string;
  severity: string;
  message: string;
  filePath: string | null;
  line: number | null;
}

/** One file's real, measured metrics — used to ground size/complexity claims instead of letting the model guess them. */
export interface FileMetricEvidence {
  filePath: string;
  lineCount: number;
  complexity: number | null;
}

export interface SeverityCountsEvidence {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

/**
 * Everything one primary agent is given to reason over — deliberately
 * bounded (see each field's source for its own limit) rather than "the
 * whole repository." Framework-independent: built by apps/worker from real
 * Postgres/pgvector data, but this type itself has no Prisma/database
 * import, so `runAgent` stays independently testable with plain fixtures.
 */
export interface AgentEvidence {
  repository: {
    fullName: string;
    description: string | null;
    defaultBranch: string;
  };
  deterministic: {
    filesAnalyzed: number;
    symbolsFound: number;
    importsFound: number;
    findingsCount: number;
    severityCounts: SeverityCountsEvidence;
    /** A bounded, largest/most-complex-first slice — never the full file list. */
    largestFiles: FileMetricEvidence[];
    /** Filtered to this agent's `relevantRuleIds` (or all findings, bounded) — see AgentSpec. */
    relevantFindings: DeterministicFindingEvidence[];
  };
  /** Phase 5 retrieval, using this agent's own `retrievalQuery` — see AgentSpec. Already budget-bounded by `buildRagContext`. */
  ragContext: RagContext;
}

/**
 * One agent's fixed identity/behavior — the "specialization" in
 * "specialized agent" lives in this data, not in seven independently
 * implemented functions (see `run-agent.ts`'s doc comment for why: same
 * "a registry of definitions, not a class hierarchy" pattern Phase 4's rule
 * engine uses).
 */
export interface AgentSpec {
  type: "ARCHITECTURE" | "CODE_QUALITY" | "SECURITY" | "PERFORMANCE" | "DEPENDENCY_RISK" | "DOCUMENTATION";
  title: string;
  /** One-paragraph framing injected near the top of the system prompt. */
  focus: string;
  /** Bullet points of specifically what to look for — from the Phase 6 spec's per-agent "Analyze:" list. */
  instructions: string[];
  /** Agent-specific severity/confidence calibration notes (e.g. Security's "don't claim exploitability," Performance's "say 'likely', never 'measured'"). */
  severityGuidance?: string;
  /** The semantic search query used to gather this agent's RAG evidence — see docs/ai-analysis.md's "retrieval strategy" section. */
  retrievalQuery: string;
  /** Restricts `deterministic.relevantFindings` to these `Finding.ruleId`s — `undefined` means "no filter, use all (bounded) findings." */
  relevantRuleIds?: string[];
}

export interface AgentRunResult {
  spec: AgentSpec;
  output: AgentOutput;
}
