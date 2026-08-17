import { prisma } from "@developer-platform/database";
import { buildRagContext, searchRepository, type AgentEvidence, type AgentSpec, type EmbeddingProvider } from "@developer-platform/ai";
import { logger } from "../logger.js";

/** How many of the largest/most-complex files to include — a bounded slice, never the full file list. */
const MAX_LARGEST_FILES = 8;
/** How many deterministic findings to include per agent — bounded so a repository with hundreds of TODOs doesn't blow out the prompt. */
const MAX_RELEVANT_FINDINGS = 15;
/** Bounds this agent's RAG context — see docs/ai-analysis.md's "retrieval strategy" section for why these are deliberately small. */
const RAG_MAX_RESULTS = 8;
const RAG_MAX_CHARACTERS = 6000;
/** How many candidate chunks to request from search before RAG-budgeting them down to the above. */
const RAG_SEARCH_LIMIT = 12;

interface GatherEvidenceParams {
  repositoryId: string;
  analysisRunId: string;
  spec: AgentSpec;
  embeddingProvider: EmbeddingProvider;
}

/**
 * Builds one agent's bounded evidence: real deterministic data (Phase 4)
 * plus an agent-specific slice of Phase 5's retrieval (never the whole
 * repository, never unbounded). This is the *only* place apps/worker reads
 * Phase 4/5 data for AI analysis — the shape it produces
 * (`AgentEvidence`, packages/ai/src/agents/types.ts) has no Prisma import
 * itself, keeping the actual agent-running logic independently testable.
 */
export async function gatherEvidenceForAgent(params: GatherEvidenceParams): Promise<AgentEvidence> {
  const { repositoryId, analysisRunId, spec, embeddingProvider } = params;

  const findingsWhere = spec.relevantRuleIds ? { analysisRunId, ruleId: { in: spec.relevantRuleIds } } : { analysisRunId };

  const [repository, analysisRun, severityGroups, largestFiles, relevantFindings] = await Promise.all([
    prisma.repository.findUniqueOrThrow({
      where: { id: repositoryId },
      select: { fullName: true, description: true, defaultBranch: true },
    }),
    prisma.analysisRun.findUniqueOrThrow({
      where: { id: analysisRunId },
      select: { filesAnalyzed: true, symbolsFound: true, importsFound: true, findingsCount: true },
    }),
    prisma.finding.groupBy({ by: ["severity"], where: { analysisRunId }, _count: { _all: true } }),
    prisma.codeMetric.findMany({
      where: { analysisRunId },
      include: { file: true },
      orderBy: [{ lineCount: "desc" }],
      take: MAX_LARGEST_FILES,
    }),
    prisma.finding.findMany({
      where: findingsWhere,
      include: { file: true },
      orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
      take: MAX_RELEVANT_FINDINGS,
    }),
  ]);

  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const group of severityGroups) {
    severityCounts[group.severity as keyof typeof severityCounts] = group._count._all;
  }

  let ragContext = buildRagContext([], { maxResults: RAG_MAX_RESULTS, maxCharacters: RAG_MAX_CHARACTERS });
  try {
    const results = await searchRepository({
      repositoryId,
      query: spec.retrievalQuery,
      limit: RAG_SEARCH_LIMIT,
      provider: embeddingProvider,
    });
    ragContext = buildRagContext(results, { maxResults: RAG_MAX_RESULTS, maxCharacters: RAG_MAX_CHARACTERS });
  } catch (error) {
    // Evidence gathering degrades gracefully to deterministic-only evidence
    // rather than failing the whole agent — a repository search-index issue
    // shouldn't block Code Quality's analysis of real Phase 4 metrics, for
    // example. Logged, not silent.
    logger.warn({ err: error, repositoryId, agent: spec.type }, "semantic retrieval failed while gathering agent evidence, continuing with deterministic evidence only");
  }

  return {
    repository,
    deterministic: {
      filesAnalyzed: analysisRun.filesAnalyzed ?? 0,
      symbolsFound: analysisRun.symbolsFound ?? 0,
      importsFound: analysisRun.importsFound ?? 0,
      findingsCount: analysisRun.findingsCount ?? 0,
      severityCounts,
      largestFiles: largestFiles.map((m) => ({ filePath: m.file.path, lineCount: m.lineCount, complexity: m.complexity })),
      relevantFindings: relevantFindings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        message: f.message,
        filePath: f.file?.path ?? null,
        line: f.line,
      })),
    },
    ragContext,
  };
}
