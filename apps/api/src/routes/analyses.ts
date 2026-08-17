import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { AnalysisRun, CodeImport, CodeMetric, CodeSymbol, Finding, RepositoryFile } from "@prisma/client";
import {
  ACTIVE_ANALYSIS_STATUSES,
  isStaleActiveRun,
  type AnalysisRunDto,
  type AnalysisStatus,
  type CodeImportDto,
  type CodeMetricDto,
  type CodeSymbolDto,
  type FindingDto,
  type Severity,
  type SeverityCounts,
} from "@developer-platform/shared";
import { requireAuth } from "../plugins/auth.js";
import { enqueueAnalysisJob } from "../queue.js";
import { env } from "../env.js";

const repositoryIdParamsSchema = z.object({
  id: z.string().cuid("Invalid repository id"),
});

// Safety cap for the run-history list endpoint below — see
// ingestions.ts's identical constant for the full rationale.
const RUN_HISTORY_LIMIT = 100;

const analysisIdParamsSchema = z.object({
  id: z.string().cuid("Invalid analysis id"),
});

const findingsQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
  severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
  ruleId: z.string().min(1).optional(),
  fileId: z.string().cuid().optional(),
});

const EMPTY_SEVERITY_COUNTS: SeverityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };

function errorBody(message: string, statusCode: number) {
  return { error: { message, statusCode } };
}

/**
 * Cheap, synchronous conversion — `severityCounts` always `null`. This is
 * what every list/embedding context uses (GET /repositories/:id/analyses,
 * and IngestionDto.latestAnalysis embedded into repository/ingestion
 * responses) so listing many rows never triggers one extra query per row.
 * See toAnalysisRunDtoWithSeverity for the one place a real breakdown is
 * worth the extra query.
 */
export function toAnalysisRunDto(run: AnalysisRun): AnalysisRunDto {
  return {
    id: run.id,
    ingestionId: run.ingestionId,
    status: run.status as AnalysisStatus,
    error: run.error,
    filesAnalyzed: run.filesAnalyzed,
    symbolsFound: run.symbolsFound,
    importsFound: run.importsFound,
    findingsCount: run.findingsCount,
    severityCounts: null,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** Adds a real severity breakdown via one grouped query — only worth it for the single-resource detail endpoint (GET /analyses/:id). */
async function toAnalysisRunDtoWithSeverity(run: AnalysisRun): Promise<AnalysisRunDto> {
  const dto = toAnalysisRunDto(run);
  if (run.status !== "COMPLETED") return dto;

  const grouped = await prisma.finding.groupBy({
    by: ["severity"],
    where: { analysisRunId: run.id },
    _count: { _all: true },
  });

  const severityCounts: SeverityCounts = { ...EMPTY_SEVERITY_COUNTS };
  for (const row of grouped) {
    severityCounts[row.severity as Severity] = row._count._all;
  }

  return { ...dto, severityCounts };
}

function toFindingDto(finding: Finding & { file: RepositoryFile | null }): FindingDto {
  return {
    id: finding.id,
    analysisRunId: finding.analysisRunId,
    fileId: finding.fileId,
    filePath: finding.file?.path ?? null,
    ruleId: finding.ruleId,
    severity: finding.severity as Severity,
    message: finding.message,
    line: finding.line,
    column: finding.column,
    metadata: (finding.metadata as Record<string, unknown> | null) ?? null,
  };
}

function toCodeSymbolDto(symbol: CodeSymbol & { file: RepositoryFile; parent: CodeSymbol | null }): CodeSymbolDto {
  return {
    id: symbol.id,
    fileId: symbol.fileId,
    filePath: symbol.file.path,
    name: symbol.name,
    kind: symbol.kind,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    exported: symbol.exported,
    parentId: symbol.parentId,
    parentName: symbol.parent?.name ?? null,
    signature: symbol.signature,
    complexity: symbol.complexity,
    parameterCount: symbol.parameterCount,
  };
}

function toCodeImportDto(
  imp: CodeImport & { file: RepositoryFile; resolvedFile: RepositoryFile | null },
): CodeImportDto {
  return {
    id: imp.id,
    fileId: imp.fileId,
    filePath: imp.file.path,
    source: imp.source,
    kind: imp.kind,
    line: imp.line,
    resolvedFileId: imp.resolvedFileId,
    resolvedFilePath: imp.resolvedFile?.path ?? null,
  };
}

function toCodeMetricDto(metric: CodeMetric & { file: RepositoryFile }): CodeMetricDto {
  return {
    fileId: metric.fileId,
    filePath: metric.file.path,
    lineCount: metric.lineCount,
    codeLineCount: metric.codeLineCount,
    commentLineCount: metric.commentLineCount,
    blankLineCount: metric.blankLineCount,
    functionCount: metric.functionCount,
    classCount: metric.classCount,
    importCount: metric.importCount,
    exportCount: metric.exportCount,
    complexity: metric.complexity,
  };
}

/** IDOR-safe lookup shared by every /analyses/:id route — an analysis run belonging to someone else's repository simply doesn't match, same 404 as a nonexistent one. */
async function findOwnedAnalysisRun(analysisId: string, userId: string): Promise<AnalysisRun | null> {
  return prisma.analysisRun.findFirst({
    where: { id: analysisId, ingestion: { repository: { userId } } },
  });
}

export function registerAnalysisRoutes(app: FastifyInstance): void {
  // Starts (or reuses/reports) analysis for a repository's latest completed
  // ingestion. Ownership is re-verified from scratch — never trusted from
  // an earlier request.
  app.post(
    "/repositories/:id/analyses",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.user) return;

      const params = repositoryIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(422).send(errorBody("Invalid repository id", 422));
      }

      const repository = await prisma.repository.findFirst({
        where: { id: params.data.id, userId: request.user.id },
      });
      if (!repository) {
        return reply.code(404).send(errorBody("Repository not found", 404));
      }

      const latestIngestion = await prisma.ingestion.findFirst({
        where: { repositoryId: repository.id },
        orderBy: { createdAt: "desc" },
      });

      if (!latestIngestion || latestIngestion.status !== "COMPLETED") {
        return reply
          .code(409)
          .send(errorBody("Repository must be successfully analyzed from a completed ingestion first", 409));
      }

      const existing = await prisma.analysisRun.findUnique({ where: { ingestionId: latestIngestion.id } });

      // A run stuck in an active status well past a reasonable timeout is
      // treated as orphaned (its worker likely crashed) rather than
      // blocking retries forever — see packages/shared/src/job-staleness.ts.
      if (
        existing &&
        ACTIVE_ANALYSIS_STATUSES.includes(existing.status as AnalysisStatus) &&
        !isStaleActiveRun(existing.updatedAt, env.STALE_ACTIVE_RUN_MINUTES)
      ) {
        return reply.code(409).send({
          error: { message: "An analysis for this ingestion is already in progress", statusCode: 409 },
          analysis: toAnalysisRunDto(existing),
        });
      }

      // Deliberately *not* reusing a COMPLETED run the way Ingestion reuses
      // a COMPLETED commit: an ingestion at a given commit is genuinely
      // identical work every time (the source bytes can't have changed),
      // but the analysis engine itself can change between two requests for
      // the same ingestion (a rule tweak, a parser fix) — so every POST
      // here always (re-)runs, reusing the row (unique on ingestionId)
      // rather than accumulating attempts as separate rows.
      const analysisRun = existing
        ? await prisma.analysisRun.update({
            where: { id: existing.id },
            data: {
              status: "QUEUED",
              error: null,
              filesAnalyzed: null,
              symbolsFound: null,
              importsFound: null,
              findingsCount: null,
              startedAt: null,
              completedAt: null,
            },
          })
        : await prisma.analysisRun.create({
            data: { ingestionId: latestIngestion.id, status: "QUEUED" },
          });

      // A retry must not leave stale rows from a previous attempt behind.
      if (existing) {
        await prisma.$transaction([
          prisma.codeSymbol.deleteMany({ where: { analysisRunId: analysisRun.id } }),
          prisma.codeImport.deleteMany({ where: { analysisRunId: analysisRun.id } }),
          prisma.dependencyEdge.deleteMany({ where: { analysisRunId: analysisRun.id } }),
          prisma.codeMetric.deleteMany({ where: { analysisRunId: analysisRun.id } }),
          prisma.finding.deleteMany({ where: { analysisRunId: analysisRun.id } }),
        ]);
      }

      await enqueueAnalysisJob({ analysisRunId: analysisRun.id, ingestionId: latestIngestion.id });
      request.log.info({ analysisRunId: analysisRun.id, ingestionId: latestIngestion.id }, "analysis job enqueued");

      return reply.code(201).send(toAnalysisRunDto(analysisRun));
    },
  );

  app.get("/repositories/:id/analyses", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = repositoryIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid repository id", 422));
    }

    const repository = await prisma.repository.findFirst({
      where: { id: params.data.id, userId: request.user.id },
    });
    if (!repository) {
      return reply.code(404).send(errorBody("Repository not found", 404));
    }

    const analyses = await prisma.analysisRun.findMany({
      where: { ingestion: { repositoryId: repository.id } },
      orderBy: { createdAt: "desc" },
      take: RUN_HISTORY_LIMIT,
    });

    return reply.send({ analyses: analyses.map(toAnalysisRunDto) });
  });

  app.get("/analyses/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = analysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid analysis id", 422));
    }

    const analysisRun = await findOwnedAnalysisRun(params.data.id, request.user.id);
    if (!analysisRun) {
      return reply.code(404).send(errorBody("Analysis not found", 404));
    }

    return reply.send(await toAnalysisRunDtoWithSeverity(analysisRun));
  });

  app.get("/analyses/:id/findings", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = analysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid analysis id", 422));
    }
    const query = findingsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(422).send(errorBody("Invalid query parameters", 422));
    }

    const analysisRun = await findOwnedAnalysisRun(params.data.id, request.user.id);
    if (!analysisRun) {
      return reply.code(404).send(errorBody("Analysis not found", 404));
    }

    const { page, pageSize, severity, ruleId, fileId } = query.data;
    const where = {
      analysisRunId: analysisRun.id,
      ...(severity ? { severity } : {}),
      ...(ruleId ? { ruleId } : {}),
      ...(fileId ? { fileId } : {}),
    };

    const [findings, total] = await Promise.all([
      prisma.finding.findMany({
        where,
        include: { file: true },
        orderBy: [{ severity: "asc" }, { createdAt: "asc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.finding.count({ where }),
    ]);

    return reply.send({ findings: findings.map(toFindingDto), total, page, pageSize });
  });

  app.get("/analyses/:id/files", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = analysisIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid analysis id", 422));
    }

    const analysisRun = await findOwnedAnalysisRun(params.data.id, request.user.id);
    if (!analysisRun) {
      return reply.code(404).send(errorBody("Analysis not found", 404));
    }

    const [metrics, symbolCounts, importCounts, findingCounts] = await Promise.all([
      prisma.codeMetric.findMany({ where: { analysisRunId: analysisRun.id }, include: { file: true } }),
      prisma.codeSymbol.groupBy({ by: ["fileId"], where: { analysisRunId: analysisRun.id }, _count: { _all: true } }),
      prisma.codeImport.groupBy({ by: ["fileId"], where: { analysisRunId: analysisRun.id }, _count: { _all: true } }),
      prisma.finding.groupBy({
        by: ["fileId"],
        where: { analysisRunId: analysisRun.id, fileId: { not: null } },
        _count: { _all: true },
      }),
    ]);

    const symbolCountByFile = new Map(symbolCounts.map((c) => [c.fileId, c._count._all]));
    const importCountByFile = new Map(importCounts.map((c) => [c.fileId, c._count._all]));
    const findingCountByFile = new Map(findingCounts.map((c) => [c.fileId as string, c._count._all]));

    const files = metrics.map((metric) => ({
      metrics: toCodeMetricDto(metric),
      symbolCount: symbolCountByFile.get(metric.fileId) ?? 0,
      importCount: importCountByFile.get(metric.fileId) ?? 0,
      findingCount: findingCountByFile.get(metric.fileId) ?? 0,
    }));

    return reply.send({ files });
  });

  // Not in the original five, but necessary for the code explorer's file
  // detail view (section 18) — symbols and imports for one specific file
  // within one analysis run, still scoped through the same ownership check.
  app.get("/analyses/:id/files/:fileId", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = z
      .object({ id: z.string().cuid("Invalid analysis id"), fileId: z.string().cuid("Invalid file id") })
      .safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid analysis or file id", 422));
    }

    const analysisRun = await findOwnedAnalysisRun(params.data.id, request.user.id);
    if (!analysisRun) {
      return reply.code(404).send(errorBody("Analysis not found", 404));
    }

    const [metric, symbols, imports] = await Promise.all([
      prisma.codeMetric.findFirst({
        where: { analysisRunId: analysisRun.id, fileId: params.data.fileId },
        include: { file: true },
      }),
      prisma.codeSymbol.findMany({
        where: { analysisRunId: analysisRun.id, fileId: params.data.fileId },
        include: { file: true, parent: true },
        orderBy: { startLine: "asc" },
      }),
      prisma.codeImport.findMany({
        where: { analysisRunId: analysisRun.id, fileId: params.data.fileId },
        include: { file: true, resolvedFile: true },
        orderBy: { line: "asc" },
      }),
    ]);

    if (!metric) {
      return reply.code(404).send(errorBody("File not found in this analysis", 404));
    }

    return reply.send({
      metrics: toCodeMetricDto(metric),
      symbols: symbols.map(toCodeSymbolDto),
      imports: imports.map(toCodeImportDto),
    });
  });
}
