import { z } from "zod";

/**
 * One citation grounding a finding — file path plus an optional line range/
 * symbol. Every finding requires at least one (see `AgentFindingSchema`
 * below) — the model is instructed (guardrails.ts) to only ever cite a
 * `citation` field it copies from the retrieved evidence it was actually
 * given, never to invent a path or line number.
 */
export const CitationSchema = z.object({
  filePath: z.string().min(1),
  startLine: z.number().int().positive().nullable(),
  endLine: z.number().int().positive().nullable(),
  symbolName: z.string().nullable(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const AIFindingSeveritySchema = z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);

/**
 * The shape every AI-generated finding must match, regardless of which
 * agent produced it — kept identical across all seven agents (including
 * the executive summary agent's `topRisks`) so the API/UI never needs
 * per-agent-shaped rendering logic. Bounded string lengths and a bounded
 * citation count keep any one finding's footprint predictable.
 */
export const AgentFindingSchema = z.object({
  category: z.string().min(1).max(60),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  severity: AIFindingSeveritySchema,
  /** 0..1 — the model's own calibrated confidence; see guardrails.ts for how it's instructed to set this honestly rather than defaulting to 1. */
  confidence: z.number().min(0).max(1),
  /** What the retrieved evidence actually shows, distinct from `recommendation` (what to do about it) — see guardrails.ts's "evidence vs. inference" rule. */
  evidence: z.string().min(1).max(2000),
  recommendation: z.string().min(1).max(1000),
  /** At least one — a finding with zero citations is not "substantive," per the Phase 6 spec's citation requirement. */
  citations: z.array(CitationSchema).min(1).max(10),
  affectedFiles: z.array(z.string()).max(20).optional(),
});
export type AgentFinding = z.infer<typeof AgentFindingSchema>;

/** The output shape every one of the six primary agents produces. */
export const AgentOutputSchema = z.object({
  summary: z.string().min(1).max(2000),
  /** Bounded — an agent that "found" 50 things has not actually prioritized; see docs/ai-analysis.md. */
  findings: z.array(AgentFindingSchema).max(20),
});
export type AgentOutput = z.infer<typeof AgentOutputSchema>;

export const OverallHealthSchema = z.enum(["EXCELLENT", "GOOD", "FAIR", "POOR", "CRITICAL"]);

/**
 * The executive summary agent's distinct output shape — it doesn't produce
 * its own fresh `findings` from raw evidence the way the six primary
 * agents do (it never retrieves evidence itself; see
 * `executive-summary.ts`). `topRisks` reuses `AgentFindingSchema` exactly
 * so the UI renders it identically to a primary agent's findings, but the
 * model is instructed to copy an underlying finding's own `citations`
 * verbatim when highlighting it here, never invent new ones.
 */
export const ExecutiveSummaryOutputSchema = z.object({
  overallHealth: OverallHealthSchema,
  summary: z.string().min(1).max(3000),
  strengths: z.array(z.string().min(1).max(300)).max(10),
  topRisks: z.array(AgentFindingSchema).max(10),
  recommendedNextSteps: z.array(z.string().min(1).max(300)).max(10),
});
export type ExecutiveSummaryOutput = z.infer<typeof ExecutiveSummaryOutputSchema>;
