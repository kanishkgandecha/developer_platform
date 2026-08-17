/**
 * Mirrors the Prisma `AIAnalysisStatus` enum (packages/database/prisma/schema.prisma).
 * Duplicated here (not imported from @prisma/client) for the same
 * dependency-free reason as AnalysisStatus/EmbeddingRunStatus.
 *
 * `COMPLETED_WITH_WARNINGS` (not just COMPLETED/FAILED) is deliberate — see
 * docs/ai-analysis.md's "partial failure" section: one agent failing
 * doesn't discard the others.
 */
export type AIAnalysisStatus = "PENDING" | "QUEUED" | "RUNNING" | "COMPLETED" | "COMPLETED_WITH_WARNINGS" | "FAILED";

/** States where a job is still queued or actively being processed by the worker. */
export const ACTIVE_AI_ANALYSIS_STATUSES: readonly AIAnalysisStatus[] = ["PENDING", "QUEUED", "RUNNING"];

export function isActiveAIAnalysisStatus(status: AIAnalysisStatus): boolean {
  return (ACTIVE_AI_ANALYSIS_STATUSES as string[]).includes(status);
}

/** Mirrors the Prisma `AgentType` enum. Exactly seven values — see docs/ai-analysis.md for what each analyzes. */
export type AgentType =
  | "ARCHITECTURE"
  | "CODE_QUALITY"
  | "SECURITY"
  | "PERFORMANCE"
  | "DEPENDENCY_RISK"
  | "DOCUMENTATION"
  | "EXECUTIVE_SUMMARY";

/**
 * Canonical execution/display order — the six primary agents (order doesn't
 * affect correctness, since they run independently, only display
 * consistency), then the executive summary agent last (this one *is*
 * load-bearing: the orchestrator always runs it after the other six).
 */
export const AGENT_TYPES: readonly AgentType[] = [
  "ARCHITECTURE",
  "CODE_QUALITY",
  "SECURITY",
  "PERFORMANCE",
  "DEPENDENCY_RISK",
  "DOCUMENTATION",
  "EXECUTIVE_SUMMARY",
];

export const PRIMARY_AGENT_TYPES: readonly AgentType[] = AGENT_TYPES.filter((a) => a !== "EXECUTIVE_SUMMARY");

/** Mirrors the Prisma `AgentRunStatus` enum. */
export type AgentRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "SKIPPED";

/** Mirrors the Prisma `AIFindingSeverity` enum. */
export type AIFindingSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export interface AISeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

/** A single citation grounding an AI finding — never invented by the model, always sourced from retrieval evidence handed to it. See docs/ai-analysis.md's "citations" section. */
export interface AICitationDto {
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolName: string | null;
}

export interface AIFindingDto {
  id: string;
  agentRunId: string;
  aiAnalysisRunId: string;
  agent: AgentType;
  category: string;
  title: string;
  summary: string;
  severity: AIFindingSeverity;
  /** 0..1 — the model's own self-reported confidence. */
  confidence: number;
  /** What the retrieved evidence actually shows, distinct from `recommendation` (what to do about it). */
  evidence: string;
  recommendation: string;
  citations: AICitationDto[];
}

export interface AgentRunDto {
  id: string;
  aiAnalysisRunId: string;
  agent: AgentType;
  status: AgentRunStatus;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  /** Only populated on the single-resource detail endpoint — see `AIAnalysisRunDto`'s equivalent doc comment. */
  findings: AIFindingDto[] | null;
}

export interface AIAnalysisRunDto {
  id: string;
  repositoryId: string;
  analysisRunId: string;
  status: AIAnalysisStatus;
  error: string | null;
  provider: string;
  model: string;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** One row per agent, in `AGENT_TYPES` order — always present (the orchestrator creates all seven PENDING rows up front), so this is the real "N of 7 agents complete" progress source. `findings` on each is `null` here (a list/status view never needs the full detail); see `GET /ai-analysis/:id/agents` for the populated form. */
  agents: Omit<AgentRunDto, "findings">[];
  /** Only present once COMPLETED/COMPLETED_WITH_WARNINGS — a cheap way for the UI to show a severity breakdown without a second request, same pattern as AnalysisRunDto.severityCounts. */
  severityCounts: AISeverityCounts | null;
}

/**
 * BullMQ queue name — a shared constant so apps/api (producer) and
 * apps/worker (consumer) can't drift on the literal string, same pattern as
 * every other queue in this project.
 */
export const AI_ANALYSIS_QUEUE_NAME = "ai-analysis";

/**
 * Job payload: identifiers only — no GitHub token, no OpenAI key, no
 * repository source code ever enters Redis, same constraint as every other
 * queue.
 */
export interface AIAnalysisJobPayload {
  aiAnalysisRunId: string;
  repositoryId: string;
  analysisRunId: string;
}
