import { prisma } from "@developer-platform/database";
import {
  AIProviderError,
  createAIChatProviderFromEnv,
  createEmbeddingProviderFromEnv,
  EmbeddingProviderError,
  PRIMARY_AGENT_SPECS,
  runAgent,
  runExecutiveSummaryAgent,
  type AgentFinding,
  type AgentRunResult,
  type AgentSpec,
  type AIProvider,
  type EmbeddingProvider,
} from "@developer-platform/ai";
import type { AIAnalysisJobPayload, AIAnalysisStatus, AgentType } from "@developer-platform/shared";
import type { Prisma } from "@prisma/client";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { gatherEvidenceForAgent } from "./evidence.js";
import { mapWithConcurrencyLimit } from "./concurrency.js";

/**
 * No filesystem/GitHub download step in this pipeline at all — unlike
 * ingestion/analysis/embedding, AI analysis only ever reads what Phases
 * 3–5 already persisted in Postgres/pgvector. No repository archive is
 * ever fetched here, and no repository code is ever executed. See
 * docs/ai-analysis.md.
 */

export class AINotConfiguredError extends Error {
  constructor() {
    super("AI analysis is not configured — OPENAI_API_KEY is not set");
    this.name = "AINotConfiguredError";
  }
}

/** User-facing — never a stack trace, never repository content, never a prompt. */
export function userFacingMessageFor(error: unknown): string {
  if (error instanceof AINotConfiguredError) return error.message;
  if (error instanceof AIProviderError) {
    return "OpenAI chat request failed — check that OPENAI_API_KEY is valid and the OpenAI account has available quota/billing configured, then try again";
  }
  if (error instanceof EmbeddingProviderError) {
    return "OpenAI embedding request failed — check that OPENAI_API_KEY is valid and the OpenAI account has available quota/billing configured, then try again";
  }
  return "AI analysis failed unexpectedly";
}

export async function failAIAnalysis(aiAnalysisRunId: string, message: string): Promise<void> {
  await prisma.aIAnalysisRun.update({
    where: { id: aiAnalysisRunId },
    data: { status: "FAILED", error: message, completedAt: new Date() },
  });
}

async function setAgentRunning(aiAnalysisRunId: string, agent: AgentType): Promise<void> {
  await prisma.agentRun.update({
    where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent } },
    data: { status: "RUNNING", startedAt: new Date() },
  });
}

async function findingsToRows(
  findings: readonly AgentFinding[],
  agentRunId: string,
  aiAnalysisRunId: string,
): Promise<Prisma.AIFindingCreateManyInput[]> {
  return findings.map((finding) => ({
    agentRunId,
    aiAnalysisRunId,
    category: finding.category,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity,
    confidence: finding.confidence,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    citations: finding.citations as Prisma.InputJsonValue,
  }));
}

/**
 * Runs one primary agent end to end: gather evidence, call the model,
 * persist the result. Never throws — a single agent's failure (exhausted
 * provider retries, an evidence-gathering error) is caught, recorded on
 * its own `AgentRun` row, and logged; it does not abort the other agents
 * or the run as a whole. Returns `null` on failure, the `{spec, output}`
 * pair on success (consumed by the executive summary agent).
 */
async function runPrimaryAgent(
  spec: AgentSpec,
  params: { aiAnalysisRunId: string; repositoryId: string; analysisRunId: string; aiProvider: AIProvider; embeddingProvider: EmbeddingProvider },
): Promise<AgentRunResult | null> {
  const { aiAnalysisRunId, repositoryId, analysisRunId, aiProvider, embeddingProvider } = params;
  const log = logger.child({ aiAnalysisRunId, agent: spec.type });

  await setAgentRunning(aiAnalysisRunId, spec.type);

  try {
    const evidence = await gatherEvidenceForAgent({ repositoryId, analysisRunId, spec, embeddingProvider });
    const output = await runAgent(spec, evidence, aiProvider);

    const agentRun = await prisma.agentRun.update({
      where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: spec.type } },
      data: { status: "COMPLETED", summary: output.summary, result: output as unknown as Prisma.InputJsonValue, completedAt: new Date() },
    });

    if (output.findings.length > 0) {
      await prisma.aIFinding.createMany({ data: await findingsToRows(output.findings, agentRun.id, aiAnalysisRunId) });
    }

    log.info({ findings: output.findings.length }, "agent completed");
    return { spec, output };
  } catch (error) {
    log.warn({ err: error }, "agent failed, continuing with the remaining agents");
    await prisma.agentRun.update({
      where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: spec.type } },
      data: { status: "FAILED", error: userFacingMessageFor(error), completedAt: new Date() },
    });
    return null;
  }
}

/**
 * The full orchestration, given already-constructed providers — the
 * testable core. `runAIAnalysis` below is the thin, real-env-only wrapper
 * the BullMQ job actually calls; unit/integration tests call this
 * directly with a mock `AIProvider`/`EmbeddingProvider` instead (see
 * apps/worker/test/ai-analysis/pipeline.test.ts), the same
 * provider-injection split `embed-files.ts`/`embedding/pipeline.ts` uses
 * for Phase 5.
 */
export async function runAIAnalysisWithProviders(
  payload: AIAnalysisJobPayload,
  providers: { aiProvider: AIProvider; embeddingProvider: EmbeddingProvider },
): Promise<void> {
  const { aiAnalysisRunId, repositoryId, analysisRunId } = payload;
  const { aiProvider, embeddingProvider } = providers;
  const log = logger.child({ aiAnalysisRunId, repositoryId, analysisRunId });

  await prisma.aIAnalysisRun.update({ where: { id: aiAnalysisRunId }, data: { status: "RUNNING", startedAt: new Date() } });
  log.info("AI analysis started");

  // All seven AgentRun rows exist up front (PENDING) so "N of 7 agents
  // complete" is always a real query, never inferred — see AgentRun's doc
  // comment in schema.prisma.
  const allAgentTypes: AgentType[] = [...PRIMARY_AGENT_SPECS.map((spec) => spec.type), "EXECUTIVE_SUMMARY"];
  await prisma.agentRun.createMany({
    data: allAgentTypes.map((agent) => ({ aiAnalysisRunId, agent, status: "PENDING" as const })),
  });

  const primaryResults = await mapWithConcurrencyLimit(PRIMARY_AGENT_SPECS, env.AI_AGENT_CONCURRENCY, (spec) =>
    runPrimaryAgent(spec, { aiAnalysisRunId, repositoryId, analysisRunId, aiProvider, embeddingProvider }),
  );
  const successfulResults = primaryResults.filter((result): result is AgentRunResult => result !== null);
  log.info({ completed: successfulResults.length, failed: primaryResults.length - successfulResults.length }, "primary agents finished");

  let finalStatus: AIAnalysisStatus;

  if (successfulResults.length === 0) {
    await prisma.agentRun.update({
      where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "EXECUTIVE_SUMMARY" } },
      data: { status: "SKIPPED", error: "No primary agent results were available to summarize", completedAt: new Date() },
    });
    finalStatus = "FAILED";
    await prisma.aIAnalysisRun.update({
      where: { id: aiAnalysisRunId },
      data: { status: finalStatus, error: "All primary agents failed", completedAt: new Date() },
    });
    log.error("all primary agents failed, AI analysis run marked FAILED");
    return;
  }

  await setAgentRunning(aiAnalysisRunId, "EXECUTIVE_SUMMARY");
  let executiveSucceeded = false;
  try {
    const executiveOutput = await runExecutiveSummaryAgent(successfulResults, aiProvider);
    const executiveAgentRun = await prisma.agentRun.update({
      where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "EXECUTIVE_SUMMARY" } },
      data: { status: "COMPLETED", summary: executiveOutput.summary, result: executiveOutput as unknown as Prisma.InputJsonValue, completedAt: new Date() },
    });
    if (executiveOutput.topRisks.length > 0) {
      await prisma.aIFinding.createMany({ data: await findingsToRows(executiveOutput.topRisks, executiveAgentRun.id, aiAnalysisRunId) });
    }
    executiveSucceeded = true;
    log.info("executive summary agent completed");
  } catch (error) {
    log.warn({ err: error }, "executive summary agent failed");
    await prisma.agentRun.update({
      where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "EXECUTIVE_SUMMARY" } },
      data: { status: "FAILED", error: userFacingMessageFor(error), completedAt: new Date() },
    });
  }

  const anyPrimaryFailed = successfulResults.length < PRIMARY_AGENT_SPECS.length;
  finalStatus = anyPrimaryFailed || !executiveSucceeded ? "COMPLETED_WITH_WARNINGS" : "COMPLETED";

  await prisma.aIAnalysisRun.update({ where: { id: aiAnalysisRunId }, data: { status: finalStatus, completedAt: new Date() } });
  log.info({ status: finalStatus }, "AI analysis completed");
}

/**
 * The real entry point the BullMQ job (jobs/ai-analysis-job.ts) calls:
 * validates preconditions, constructs the real OpenAI-backed providers
 * from env, and delegates to `runAIAnalysisWithProviders`. Never throws
 * for a permanent/business-rule failure (not configured, analysis not
 * COMPLETED, repository not indexed) — those are recorded as FAILED and
 * returned normally, no BullMQ retry. A genuinely unexpected error (e.g. a
 * database connectivity blip while loading the run record) propagates so
 * BullMQ can retry the whole job — see docs/ai-analysis.md's "error
 * handling" section.
 */
export async function runAIAnalysis(payload: AIAnalysisJobPayload): Promise<void> {
  const { aiAnalysisRunId, repositoryId, analysisRunId } = payload;
  const log = logger.child({ aiAnalysisRunId, repositoryId, analysisRunId });

  const aiAnalysisRun = await prisma.aIAnalysisRun.findUnique({
    where: { id: aiAnalysisRunId },
    include: { analysisRun: { include: { embeddingRun: true } } },
  });

  if (!aiAnalysisRun) {
    log.warn("AI analysis job for a missing run record, skipping");
    return;
  }

  const { analysisRun } = aiAnalysisRun;
  if (analysisRun.status !== "COMPLETED") {
    log.error({ analysisStatus: analysisRun.status }, "AI analysis job for an analysis run that is not COMPLETED");
    await failAIAnalysis(aiAnalysisRunId, "Code analysis must be completed before AI analysis can run");
    return;
  }
  if (!analysisRun.embeddingRun || analysisRun.embeddingRun.status !== "COMPLETED") {
    log.error({ embeddingStatus: analysisRun.embeddingRun?.status ?? "NONE" }, "AI analysis job for a repository that is not semantically indexed");
    await failAIAnalysis(aiAnalysisRunId, "The repository must be indexed for semantic search before AI analysis can run");
    return;
  }

  const aiProvider = createAIChatProviderFromEnv(env);
  const embeddingProvider = createEmbeddingProviderFromEnv(env);
  if (!aiProvider || !embeddingProvider) {
    log.error("AI analysis requested but OPENAI_API_KEY is not configured");
    await failAIAnalysis(aiAnalysisRunId, userFacingMessageFor(new AINotConfiguredError()));
    return;
  }

  await runAIAnalysisWithProviders({ aiAnalysisRunId, repositoryId, analysisRunId }, { aiProvider, embeddingProvider });
}
