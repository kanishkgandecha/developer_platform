import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { EmbeddingRun } from "@prisma/client";
import {
  ACTIVE_EMBEDDING_STATUSES,
  type EmbeddingRunDto,
  type EmbeddingRunStatus,
  type SemanticSearchResponse,
  type SemanticSearchStatus,
} from "@developer-platform/shared";
import { requireAuth } from "../plugins/auth.js";
import { enqueueEmbeddingJob } from "../queue.js";
import { env } from "../env.js";
import { getEmbeddingProvider } from "../services/embedding-provider.js";
import { searchRepository } from "../services/search.js";

const repositoryIdParamsSchema = z.object({
  id: z.string().cuid("Invalid repository id"),
});

const embeddingIdParamsSchema = z.object({
  id: z.string().cuid("Invalid embedding run id"),
});

const searchBodySchema = z.object({
  query: z.string().trim().min(1, "query is required").max(500, "query is too long"),
  limit: z.coerce.number().int().positive().max(50).default(10),
});

function errorBody(message: string, statusCode: number) {
  return { error: { message, statusCode } };
}

function toEmbeddingRunDto(run: EmbeddingRun): EmbeddingRunDto {
  return {
    id: run.id,
    repositoryId: run.repositoryId,
    analysisRunId: run.analysisRunId,
    status: run.status as EmbeddingRunStatus,
    error: run.error,
    model: run.model,
    dimensions: run.dimensions,
    chunksDiscovered: run.chunksDiscovered,
    chunksReused: run.chunksReused,
    chunksEmbedded: run.chunksEmbedded,
    chunksDeleted: run.chunksDeleted,
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

/** IDOR-safe lookup shared by every /embeddings/:id route — same pattern as analyses.ts's findOwnedAnalysisRun. */
async function findOwnedEmbeddingRun(embeddingRunId: string, userId: string): Promise<EmbeddingRun | null> {
  return prisma.embeddingRun.findFirst({
    where: { id: embeddingRunId, repository: { userId } },
  });
}

/** Repository ownership check shared by every route below — never trusts an earlier request, matches every other route file's IDOR-safe pattern. */
async function findOwnedRepository(repositoryId: string, userId: string) {
  return prisma.repository.findFirst({ where: { id: repositoryId, userId } });
}

export function registerEmbeddingRoutes(app: FastifyInstance): void {
  // Starts (or reuses/reports) semantic indexing for a repository's latest
  // completed code analysis. Mirrors POST /repositories/:id/analyses'
  // reuse-by-id pattern: EmbeddingRun is unique on analysisRunId, so a
  // retry reuses (and resets) the same row rather than accumulating rows.
  app.post(
    "/repositories/:id/embeddings",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.user) return;

      const params = repositoryIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(422).send(errorBody("Invalid repository id", 422));
      }

      if (!env.OPENAI_API_KEY) {
        return reply.code(503).send(errorBody("Semantic search is not configured on this server (OPENAI_API_KEY is not set)", 503));
      }

      const repository = await findOwnedRepository(params.data.id, request.user.id);
      if (!repository) {
        return reply.code(404).send(errorBody("Repository not found", 404));
      }

      const latestIngestion = await prisma.ingestion.findFirst({
        where: { repositoryId: repository.id },
        orderBy: { createdAt: "desc" },
        include: { analysisRun: true },
      });

      if (!latestIngestion?.analysisRun || latestIngestion.analysisRun.status !== "COMPLETED") {
        return reply
          .code(409)
          .send(errorBody("Repository must have a completed code analysis before it can be indexed for search", 409));
      }
      const analysisRun = latestIngestion.analysisRun;

      const existing = await prisma.embeddingRun.findUnique({ where: { analysisRunId: analysisRun.id } });

      if (existing && ACTIVE_EMBEDDING_STATUSES.includes(existing.status as EmbeddingRunStatus)) {
        return reply.code(409).send({
          error: { message: "Semantic indexing for this analysis is already in progress", statusCode: 409 },
          embedding: toEmbeddingRunDto(existing),
        });
      }

      const embeddingRun = existing
        ? await prisma.embeddingRun.update({
            where: { id: existing.id },
            data: {
              status: "QUEUED",
              error: null,
              model: env.EMBEDDING_MODEL,
              dimensions: env.EMBEDDING_DIMENSIONS,
              chunksDiscovered: null,
              chunksReused: null,
              chunksEmbedded: null,
              chunksDeleted: null,
              startedAt: null,
              completedAt: null,
            },
          })
        : await prisma.embeddingRun.create({
            data: {
              repositoryId: repository.id,
              analysisRunId: analysisRun.id,
              status: "QUEUED",
              model: env.EMBEDDING_MODEL,
              dimensions: env.EMBEDDING_DIMENSIONS,
            },
          });

      await enqueueEmbeddingJob({ embeddingRunId: embeddingRun.id, repositoryId: repository.id, analysisRunId: analysisRun.id });
      request.log.info({ embeddingRunId: embeddingRun.id, repositoryId: repository.id }, "embedding job enqueued");

      return reply.code(201).send(toEmbeddingRunDto(embeddingRun));
    },
  );

  app.get("/repositories/:id/embeddings", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = repositoryIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid repository id", 422));
    }

    const repository = await findOwnedRepository(params.data.id, request.user.id);
    if (!repository) {
      return reply.code(404).send(errorBody("Repository not found", 404));
    }

    const embeddings = await prisma.embeddingRun.findMany({
      where: { repositoryId: repository.id },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({ embeddings: embeddings.map(toEmbeddingRunDto) });
  });

  app.get("/embeddings/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = embeddingIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid embedding run id", 422));
    }

    const embeddingRun = await findOwnedEmbeddingRun(params.data.id, request.user.id);
    if (!embeddingRun) {
      return reply.code(404).send(errorBody("Embedding run not found", 404));
    }

    return reply.send(toEmbeddingRunDto(embeddingRun));
  });

  // Repository-scoped semantic (+ lexical) search. Every precondition that
  // isn't a hard error (never configured, never indexed, indexing right
  // now) is reported via `status` in a 200 response rather than a 4xx/5xx —
  // the request itself was well-formed, the repository just isn't
  // searchable yet, and the UI needs to tell those apart (see
  // docs/semantic-search.md and Phase 5 spec §27).
  app.post(
    "/repositories/:id/search",
    { preHandler: requireAuth, config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.user) return;

      const params = repositoryIdParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(422).send(errorBody("Invalid repository id", 422));
      }
      const body = searchBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(422).send(errorBody(body.error.issues[0]?.message ?? "Invalid search request", 422));
      }
      const { query, limit } = body.data;

      const repository = await findOwnedRepository(params.data.id, request.user.id);
      if (!repository) {
        return reply.code(404).send(errorBody("Repository not found", 404));
      }

      const respond = (status: SemanticSearchStatus, results: SemanticSearchResponse["results"] = []) =>
        reply.send({ status, query, results } satisfies SemanticSearchResponse);

      const provider = getEmbeddingProvider();
      if (!provider) {
        return respond("not_configured");
      }

      const latestEmbeddingRun = await prisma.embeddingRun.findFirst({
        where: { repositoryId: repository.id },
        orderBy: { createdAt: "desc" },
      });

      if (!latestEmbeddingRun || latestEmbeddingRun.status === "FAILED") {
        return respond("not_indexed");
      }
      if (ACTIVE_EMBEDDING_STATUSES.includes(latestEmbeddingRun.status as EmbeddingRunStatus)) {
        return respond("indexing");
      }

      let results;
      try {
        results = await searchRepository({ repositoryId: repository.id, query, limit, provider });
      } catch (cause) {
        request.log.error({ err: cause }, "semantic search failed");
        return reply.code(502).send(errorBody("Semantic search is temporarily unavailable — try again shortly", 502));
      }

      return respond("ready", results);
    },
  );
}
