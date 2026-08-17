import type { FastifyInstance } from "fastify";
import type { HealthStatus } from "@developer-platform/shared";
import { checkDatabaseConnection } from "@developer-platform/database";
import { env } from "../env.js";
import { checkRedisConnection, checkWorkerHeartbeat } from "../redis.js";
import { isGitHubOAuthConfigured } from "../services/github.js";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async (_request, reply) => {
    const [databaseOk, redisOk, workerOk] = await Promise.all([
      checkDatabaseConnection(),
      checkRedisConnection(),
      checkWorkerHeartbeat(),
    ]);

    const body: HealthStatus = {
      // Overall status reflects the API's own core dependencies
      // (database, Redis) — the worker is a separate optional process the
      // API doesn't depend on to function, so its liveness is informational
      // (`checks.worker`) rather than degrading the top-level status.
      status: databaseOk && redisOk ? "ok" : "degraded",
      environment: env.NODE_ENV,
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseOk ? "ok" : "error",
        redis: redisOk ? "ok" : "error",
        worker: workerOk ? "ok" : "error",
        githubOAuth: isGitHubOAuthConfigured() ? "configured" : "not_configured",
      },
    };

    // A degraded dependency isn't a 5xx on the API itself — the endpoint
    // reached, and clients should read `status`/`checks` for details.
    return reply.code(200).send(body);
  });
}
