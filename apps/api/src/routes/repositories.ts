import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { RepositoryDto } from "@developer-platform/shared";
import type { Ingestion, Repository } from "@prisma/client";
import { requireAuth } from "../plugins/auth.js";
import { decryptToken } from "../services/crypto.js";
import { GitHubApiError, listAuthenticatedRepositories } from "../services/github.js";
import { toIngestionDto } from "./ingestions.js";

const repositoryIdParamsSchema = z.object({
  id: z.string().cuid("Invalid repository id"),
});

/** Embeds only the most recent ingestion — see RepositoryDto.latestIngestion's doc comment. */
const LATEST_INGESTION_INCLUDE = {
  ingestions: { orderBy: { createdAt: "desc" as const }, take: 1 },
};

type RepositoryWithLatestIngestion = Repository & { ingestions: Ingestion[] };

function toDto(repo: RepositoryWithLatestIngestion): RepositoryDto {
  return {
    id: repo.id,
    githubId: repo.githubId,
    owner: repo.owner,
    name: repo.name,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    private: repo.private,
    htmlUrl: repo.htmlUrl,
    description: repo.description,
    updatedAt: repo.updatedAt.toISOString(),
    latestIngestion: repo.ingestions[0] ? toIngestionDto(repo.ingestions[0]) : null,
  };
}

export function registerRepositoryRoutes(app: FastifyInstance): void {
  // Reads whatever's already persisted — fast, no GitHub call. The initial
  // sync (or a manual refresh) happens via POST /repositories/connect.
  app.get("/repositories", { preHandler: requireAuth }, async (request, reply) => {
    // requireAuth already 401'd and short-circuited if this isn't set; the
    // guard here is just for TypeScript's narrowing, not a second auth check.
    if (!request.user) return;

    const repositories = await prisma.repository.findMany({
      where: { userId: request.user.id },
      orderBy: { updatedAt: "desc" },
      include: LATEST_INGESTION_INCLUDE,
    });

    return reply.send({ repositories: repositories.map(toDto) });
  });

  app.get("/repositories/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = repositoryIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { message: "Invalid repository id", statusCode: 400 },
      });
    }

    // Scoping the query to `userId: request.user.id` (never trusting a
    // user-supplied user id, and never querying by `id` alone) is what
    // prevents IDOR here: a repository that exists but belongs to someone
    // else simply doesn't match, and gets the same 404 as one that doesn't
    // exist at all — existence isn't leaked either way.
    const repository = await prisma.repository.findFirst({
      where: { id: params.data.id, userId: request.user.id },
      include: LATEST_INGESTION_INCLUDE,
    });

    if (!repository) {
      return reply.code(404).send({ error: { message: "Repository not found", statusCode: 404 } });
    }

    return reply.send(toDto(repository));
  });

  app.delete("/repositories/:id", { preHandler: requireAuth }, async (request, reply) => {
    if (!request.user) return;

    const params = repositoryIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({
        error: { message: "Invalid repository id", statusCode: 400 },
      });
    }

    const { count } = await prisma.repository.deleteMany({
      where: { id: params.data.id, userId: request.user.id },
    });

    if (count === 0) {
      return reply.code(404).send({ error: { message: "Repository not found", statusCode: 404 } });
    }

    return reply.code(204).send();
  });

  // Live-syncs from GitHub: fetches everything the user currently has
  // access to and upserts it as Repository rows. Metadata only — never
  // clones, downloads, or reads repository contents.
  app.post(
    "/repositories/connect",
    { preHandler: requireAuth, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!request.user) return;

      const githubAccount = await prisma.gitHubAccount.findUnique({
        where: { userId: request.user.id },
      });

      if (!githubAccount) {
        return reply.code(409).send({
          error: { message: "No GitHub account connected", statusCode: 409 },
        });
      }

      let accessToken: string;
      try {
        accessToken = decryptToken(githubAccount.accessTokenEncrypted);
      } catch (cause) {
        request.log.error({ err: cause }, "failed to decrypt stored GitHub token");
        return reply.code(409).send({
          error: {
            message: "GitHub connection is invalid — please reconnect your GitHub account",
            statusCode: 409,
          },
        });
      }

      let githubRepos;
      try {
        githubRepos = await listAuthenticatedRepositories(accessToken);
      } catch (cause) {
        if (cause instanceof GitHubApiError) {
          request.log.warn({ err: cause }, "GitHub repository sync failed");
          return reply.code(cause.status === 401 ? 409 : 502).send({
            error: {
              message:
                cause.status === 401
                  ? "GitHub connection is invalid — please reconnect your GitHub account"
                  : "GitHub is temporarily unavailable — try again shortly",
              statusCode: cause.status === 401 ? 409 : 502,
            },
          });
        }
        throw cause;
      }

      const userId = request.user.id;
      const synced = await prisma.$transaction(
        githubRepos.map((repo) =>
          prisma.repository.upsert({
            where: { userId_githubId: { userId, githubId: repo.githubId } },
            update: {
              owner: repo.owner,
              name: repo.name,
              fullName: repo.fullName,
              defaultBranch: repo.defaultBranch,
              private: repo.private,
              htmlUrl: repo.htmlUrl,
              description: repo.description,
            },
            create: { userId, ...repo },
            include: LATEST_INGESTION_INCLUDE,
          }),
        ),
      );

      return reply.send({ repositories: synced.map(toDto) });
    },
  );
}
