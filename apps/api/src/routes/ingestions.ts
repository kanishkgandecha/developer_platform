import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { Ingestion } from "@prisma/client";
import {
  ACTIVE_INGESTION_STATUSES,
  type IngestionDto,
  type IngestionStatus,
} from "@developer-platform/shared";
import { requireAuth } from "../plugins/auth.js";
import { enqueueIngestionJob } from "../queue.js";
import { decryptToken } from "../services/crypto.js";
import { GitHubApiError, getBranchHeadSha } from "../services/github.js";

const repositoryIdParamsSchema = z.object({
  id: z.string().cuid("Invalid repository id"),
});

const ingestionIdParamsSchema = z.object({
  id: z.string().cuid("Invalid ingestion id"),
});

export function toIngestionDto(ingestion: Ingestion): IngestionDto {
  return {
    id: ingestion.id,
    repositoryId: ingestion.repositoryId,
    status: ingestion.status as IngestionStatus,
    commitSha: ingestion.commitSha,
    progress: ingestion.progress,
    error: ingestion.error,
    fileCount: ingestion.fileCount,
    sourceFileCount: ingestion.sourceFileCount,
    startedAt: ingestion.startedAt?.toISOString() ?? null,
    completedAt: ingestion.completedAt?.toISOString() ?? null,
    createdAt: ingestion.createdAt.toISOString(),
    updatedAt: ingestion.updatedAt.toISOString(),
  };
}

function errorBody(message: string, statusCode: number) {
  return { error: { message, statusCode } };
}

export function registerIngestionRoutes(app: FastifyInstance): void {
  // Starts (or reuses/reports) ingestion for a repository. Ownership is
  // re-verified from scratch here — never trusted from an earlier request.
  app.post(
    "/repositories/:id/ingestions",
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

      const githubAccount = await prisma.gitHubAccount.findUnique({
        where: { userId: request.user.id },
      });
      if (!githubAccount) {
        return reply.code(409).send(errorBody("No GitHub account connected", 409));
      }

      let accessToken: string;
      try {
        accessToken = decryptToken(githubAccount.accessTokenEncrypted);
      } catch (cause) {
        request.log.error({ err: cause }, "failed to decrypt stored GitHub token");
        return reply
          .code(409)
          .send(errorBody("GitHub connection is invalid — please reconnect your GitHub account", 409));
      }

      // Resolving the current commit SHA is deliberately a lightweight,
      // synchronous part of this request — the heavy work (archive
      // download/extraction/scan) only ever happens in the worker. This is
      // also the idempotency boundary: see docs/repository-ingestion.md.
      let commitSha: string;
      try {
        commitSha = await getBranchHeadSha(accessToken, repository.owner, repository.name, repository.defaultBranch);
      } catch (cause) {
        if (cause instanceof GitHubApiError) {
          request.log.warn({ err: cause }, "failed to resolve repository HEAD commit");
          if (cause.status === 404) {
            return reply.code(404).send(errorBody("Repository or branch not found on GitHub", 404));
          }
          if (cause.status === 401) {
            return reply
              .code(409)
              .send(errorBody("GitHub connection is invalid — please reconnect your GitHub account", 409));
          }
          return reply.code(502).send(errorBody("GitHub is temporarily unavailable — try again shortly", 502));
        }
        throw cause;
      }

      const existing = await prisma.ingestion.findUnique({
        where: { repositoryId_commitSha: { repositoryId: repository.id, commitSha } },
      });

      if (existing && ACTIVE_INGESTION_STATUSES.includes(existing.status as IngestionStatus)) {
        return reply.code(409).send({
          error: { message: "An ingestion for this commit is already in progress", statusCode: 409 },
          ingestion: toIngestionDto(existing),
        });
      }

      if (existing && existing.status === "COMPLETED") {
        // Idempotent reuse — this exact commit has already been ingested
        // successfully, so there's no new work to do or job to enqueue.
        return reply.code(200).send(toIngestionDto(existing));
      }

      const ingestion = existing
        ? // Retry: reuse the row (the unique (repositoryId, commitSha)
          // constraint means we can't create a second one for the same
          // commit) rather than accumulating failed attempts as separate rows.
          await prisma.ingestion.update({
            where: { id: existing.id },
            data: {
              status: "QUEUED",
              progress: 0,
              error: null,
              fileCount: null,
              sourceFileCount: null,
              startedAt: null,
              completedAt: null,
            },
          })
        : await prisma.ingestion.create({
            data: { repositoryId: repository.id, commitSha, status: "QUEUED", progress: 0 },
          });

      await enqueueIngestionJob({ ingestionId: ingestion.id, repositoryId: repository.id });
      request.log.info({ ingestionId: ingestion.id, repositoryId: repository.id }, "ingestion job enqueued");

      return reply.code(201).send(toIngestionDto(ingestion));
    },
  );

  app.get("/repositories/:id/ingestions", { preHandler: requireAuth }, async (request, reply) => {
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

    const ingestions = await prisma.ingestion.findMany({
      where: { repositoryId: repository.id },
      orderBy: { createdAt: "desc" },
    });

    return reply.send({ ingestions: ingestions.map(toIngestionDto) });
  });

  app.get("/ingestions/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = ingestionIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(422).send(errorBody("Invalid ingestion id", 422));
    }

    // IDOR-safe: filtering through the repository relation's userId, not a
    // bare `id` lookup — an ingestion belonging to someone else's
    // repository simply doesn't match, same 404 as a nonexistent one.
    const ingestion = await prisma.ingestion.findFirst({
      where: { id: params.data.id, repository: { userId: request.user.id } },
    });
    if (!ingestion) {
      return reply.code(404).send(errorBody("Ingestion not found", 404));
    }

    return reply.send(toIngestionDto(ingestion));
  });
}
