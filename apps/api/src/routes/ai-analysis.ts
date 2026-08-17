import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { AgentRun, AIAnalysisRun, AIFinding } from "@prisma/client";
import {
  ACTIVE_AI_ANALYSIS_STATUSES,
  isStaleActiveRun,
  type AgentRunDto,
  type AgentType,
  type AIAnalysisRunDto,
  type AIAnalysisStatus,
  type AICitationDto,
  type AIFindingDto,
  type AIFindingSeverity,
  type AISeverityCounts,
} from "@developer-platform/shared";
import { requireAuth } from "../plugins/auth.js";
import { enqueueAIAnalysisJob } from "../queue.js";
import { env } from "../env.js";

const repositoryIdParamsSchema = z.object({
  id: z.string().cuid("Invalid repository id"),
});

// Safety cap for the run-history list endpoint below — see
// ingestions.ts's identical constant for the full rationale.
const RUN_HISTORY_LIMIT = 100;

const aiAnalysisIdParamsSchema = z.object({
  id: z.string().cuid("Invalid AI analysis id"),
});

const findingsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional(),
  agent: z
    .enum(["ARCHITECTURE", "CODE_QUALITY", "SECURITY", "PERFORMANCE", "DEPENDENCY_RISK", "DOCUMENTATION", "EXECUTIVE_SUMMARY"])
    .optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
});

const EMPTY_AI_SEVERITY_COUNTS: AISeverityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
/** Terminal states a severity breakdown is meaningful for — an active or never-run analysis has no findings yet. */
const TERMINAL_STATUSES_WITH_FINDINGS: readonly AIAnalysisStatus[] = ["COMPLETED", "COMPLETED_WITH_WARNINGS"];

function errorBody(message: string, statusCode: number) {
  return { error: { message, statusCode } };
}

function toAgentRunBriefDto(run: AgentRun): Omit<AgentRunDto, "findings"> {
  return {
    id: run.id,
    aiAnalysisRunId: run.aiAnalysisRunId,
    agent: run.agent as AgentType,
    status: run.status,
    summary: run.summary,
    error: run.error,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

/** `agent` isn't stored directly on AIFinding (it's reached via `agentRunId`) — every call site here already has the owning AgentRun loaded (via an `include`), so the caller passes its `agent` value explicitly rather than this doing a second lookup. */
function toAIFindingDtoWithAgent(finding: AIFinding, agent: AgentType): AIFindingDto {
  return {
    id: finding.id,
    agentRunId: finding.agentRunId,
    aiAnalysisRunId: finding.aiAnalysisRunId,
    agent,
    category: finding.category,
    title: finding.title,
    summary: finding.summary,
    severity: finding.severity as AIFindingSeverity,
    confidence: finding.confidence,
    evidence: finding.evidence,
    recommendation: finding.recommendation,
    citations: finding.citations as unknown as AICitationDto[],
  };
}

/** Cheap, synchronous — `severityCounts: null`, same pattern as toAnalysisRunDto/toEmbeddingRunDto for list/embedded contexts. See toAIAnalysisRunDtoWithSeverity for the one place a real breakdown is worth the extra query. */
function toAIAnalysisRunDto(run: AIAnalysisRun & { agentRuns: AgentRun[] }): AIAnalysisRunDto {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    analysisRunId: run.analysisRunId,
    status: run.status as AIAnalysisStatus,
    error: run.error,
    provider: run.provider,
    model: run.model,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    agents: run.agentRuns.map(toAgentRunBriefDto),
    severityCounts: null,
  };
}

async function toAIAnalysisRunDtoWithSeverity(run: AIAnalysisRun & { agentRuns: AgentRun[] }): Promise<AIAnalysisRunDto> {
  const dto = toAIAnalysisRunDto(run);
  if (!TERMINAL_STATUSES_WITH_FINDINGS.includes(run.status as AIAnalysisStatus)) return dto;

  const grouped = await prisma.aIFinding.groupBy({ by: ["severity"], where: { aiAnalysisRunId: run.id }, _count: { _all: true } });
  const severityCounts: AISeverityCounts = { ...EMPTY_AI_SEVERITY_COUNTS };
  for (const row of grouped) {
    severityCounts[row.severity as AIFindingSeverity] = row._count._all;
  }
  return { ...dto, severityCounts };
}

/** IDOR-safe lookup shared by every /ai-analysis/:id route — an AI analysis run belonging to someone else's repository simply doesn't match, same 404 as a nonexistent one. */
async function findOwnedAIAnalysisRun(aiAnalysisRunId: string, userId: string): Promise<(AIAnalysisRun & { agentRuns: AgentRun[] }) | null> {
  return prisma.aIAnalysisRun.findFirst({
    where: { id: aiAnalysisRunId, repository: { userId } },
    include: { agentRuns: true },
  });
}

async function findOwnedRepository(repositoryId: string, userId: string) {
  return prisma.repository.findFirst({ where: { id: repositoryId, userId } });
}

export function registerAIAnalysisRoutes(app: FastifyInstance): void {
  // Starts (or reuses/reports) AI analysis for a repository's latest
  // completed code analysis and semantic index. Mirrors
  // POST /repositories/:id/embeddings' reuse-by-id pattern: AIAnalysisRun
  // is unique on analysisRunId, so a retry reuses (and resets) the same
  // row — its AgentRun/AIFinding children are deleted first (cascade),
  // same "a retry must not leave stale rows from a previous attempt
  // behind" rule POST /repositories/:id/analyses established.
  app.post(
    "/repositories/:id/ai-analysis",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.user) return;

      const params = repositoryIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(422).send(errorBody("Invalid repository id", 422));
      }

      if (!env.OPENAI_API_KEY) {
        return reply.code(503).send(errorBody("AI analysis is not configured on this server (OPENAI_API_KEY is not set)", 503));
      }

      const repository = await findOwnedRepository(params.data.id, request.user.id);
      if (!repository) {
        return reply.code(404).send(errorBody("Repository not found", 404));
      }

      const latestIngestion = await prisma.ingestion.findFirst({
        where: { repositoryId: repository.id },
        orderBy: { createdAt: "desc" },
        include: { analysisRun: { include: { embeddingRun: true } } },
      });

      if (!latestIngestion?.analysisRun || latestIngestion.analysisRun.status !== "COMPLETED") {
        return reply.code(409).send(errorBody("Repository must have a completed code analysis before AI analysis can run", 409));
      }
      const analysisRun = latestIngestion.analysisRun;
      if (!analysisRun.embeddingRun || analysisRun.embeddingRun.status !== "COMPLETED") {
        return reply.code(409).send(errorBody("Repository must be indexed for semantic search before AI analysis can run", 409));
      }

      const existing = await prisma.aIAnalysisRun.findUnique({ where: { analysisRunId: analysisRun.id }, include: { agentRuns: true } });

      // A run stuck in an active status well past a reasonable timeout is
      // treated as orphaned (its worker likely crashed) rather than
      // blocking retries forever — see packages/shared/src/job-staleness.ts.
      if (
        existing &&
        ACTIVE_AI_ANALYSIS_STATUSES.includes(existing.status as AIAnalysisStatus) &&
        !isStaleActiveRun(existing.updatedAt, env.STALE_ACTIVE_RUN_MINUTES)
      ) {
        return reply.code(409).send({
          error: { message: "AI analysis for this repository is already in progress", statusCode: 409 },
          aiAnalysis: toAIAnalysisRunDto(existing),
        });
      }

      let aiAnalysisRun: AIAnalysisRun & { agentRuns: AgentRun[] };
      if (existing) {
        await prisma.agentRun.deleteMany({ where: { aiAnalysisRunId: existing.id } }); // cascades to AIFinding
        aiAnalysisRun = {
          ...(await prisma.aIAnalysisRun.update({
            where: { id: existing.id },
            data: { status: "QUEUED", error: null, provider: "openai", model: env.OPENAI_MODEL, startedAt: null, completedAt: null },
          })),
          agentRuns: [],
        };
      } else {
        aiAnalysisRun = {
          ...(await prisma.aIAnalysisRun.create({
            data: { repositoryId: repository.id, analysisRunId: analysisRun.id, status: "QUEUED", provider: "openai", model: env.OPENAI_MODEL },
          })),
          agentRuns: [],
        };
      }

      await enqueueAIAnalysisJob({ aiAnalysisRunId: aiAnalysisRun.id, repositoryId: repository.id, analysisRunId: analysisRun.id });
      request.log.info({ aiAnalysisRunId: aiAnalysisRun.id, repositoryId: repository.id }, "AI analysis job enqueued");

      return reply.code(201).send(toAIAnalysisRunDto(aiAnalysisRun));
    },
  );

  app.get("/repositories/:id/ai-analysis", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = repositoryIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid repository id", 422));
    }

    const repository = await findOwnedRepository(params.data.id, request.user.id);
    if (!repository) {
      return reply.code(404).send(errorBody("Repository not found", 404));
    }

    const runs = await prisma.aIAnalysisRun.findMany({
      where: { repositoryId: repository.id },
      orderBy: { createdAt: "desc" },
      include: { agentRuns: true },
      take: RUN_HISTORY_LIMIT,
    });

    return reply.send({ aiAnalyses: runs.map(toAIAnalysisRunDto) });
  });

  app.get("/ai-analysis/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = aiAnalysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid AI analysis id", 422));
    }

    const run = await findOwnedAIAnalysisRun(params.data.id, request.user.id);
    if (!run) {
      return reply.code(404).send(errorBody("AI analysis not found", 404));
    }

    return reply.send(await toAIAnalysisRunDtoWithSeverity(run));
  });

  // Every agent, with its own findings populated — the agent-cards view.
  app.get("/ai-analysis/:id/agents", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = aiAnalysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid AI analysis id", 422));
    }

    const run = await findOwnedAIAnalysisRun(params.data.id, request.user.id);
    if (!run) {
      return reply.code(404).send(errorBody("AI analysis not found", 404));
    }

    const agentRuns = await prisma.agentRun.findMany({
      where: { aiAnalysisRunId: run.id },
      include: { findings: true },
      orderBy: { createdAt: "asc" },
    });

    const dtos: AgentRunDto[] = agentRuns.map((agentRun) => ({
      ...toAgentRunBriefDto(agentRun),
      findings: agentRun.findings.map((f) => toAIFindingDtoWithAgent(f, agentRun.agent as AgentType)),
    }));

    return reply.send({ agents: dtos });
  });

  app.get("/ai-analysis/:id/findings", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = aiAnalysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid AI analysis id", 422));
    }
    const query = findingsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send(errorBody("Invalid query parameters", 422));
    }

    const run = await findOwnedAIAnalysisRun(params.data.id, request.user.id);
    if (!run) {
      return reply.code(404).send(errorBody("AI analysis not found", 404));
    }

    const { page, pageSize, severity, agent, minConfidence } = query.data;
    const where = {
      aiAnalysisRunId: run.id,
      ...(severity ? { severity } : {}),
      ...(agent ? { agentRun: { agent } } : {}),
      ...(minConfidence !== undefined ? { confidence: { gte: minConfidence } } : {}),
    };

    const [findings, total] = await Promise.all([
      prisma.aIFinding.findMany({
        where,
        include: { agentRun: true },
        orderBy: [{ severity: "asc" }, { confidence: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.aIFinding.count({ where }),
    ]);

    return reply.send({
      findings: findings.map((f) => toAIFindingDtoWithAgent(f, f.agentRun.agent as AgentType)),
      total,
      page,
      pageSize,
    });
  });

  app.get("/ai-analysis/:id/findings/:findingId", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const paramsSchema = z.object({ id: z.string().cuid("Invalid AI analysis id"), findingId: z.string().cuid("Invalid finding id") });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid AI analysis or finding id", 422));
    }

    const run = await findOwnedAIAnalysisRun(params.data.id, request.user.id);
    if (!run) {
      return reply.code(404).send(errorBody("AI analysis not found", 404));
    }

    const finding = await prisma.aIFinding.findFirst({
      where: { id: params.data.findingId, aiAnalysisRunId: run.id },
      include: { agentRun: true },
    });
    if (!finding) {
      return reply.code(404).send(errorBody("Finding not found", 404));
    }

    return reply.send(toAIFindingDtoWithAgent(finding, finding.agentRun.agent as AgentType));
  });
}
