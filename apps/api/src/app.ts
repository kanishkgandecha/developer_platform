import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import { loggerOptions } from "./logger.js";
import { env } from "./env.js";
import { redis } from "./redis.js";
import authPlugin from "./plugins/auth.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerRepositoryRoutes } from "./routes/repositories.js";
import { registerIngestionRoutes } from "./routes/ingestions.js";
import { registerAnalysisRoutes } from "./routes/analyses.js";
import { registerEmbeddingRoutes } from "./routes/embeddings.js";
import { registerAIAnalysisRoutes } from "./routes/ai-analysis.js";

/**
 * Builds (but does not start listening on) the Fastify instance. Kept
 * separate from index.ts so tests can exercise routes via `.inject()`
 * without binding a real port.
 */
export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: loggerOptions,
  });

  app.register(sensible);

  // `origin` is locked to the configured WEB_URL (not `true`/reflect-any)
  // now that requests carry session cookies — reflecting an arbitrary
  // Origin back with `credentials: true` would let any site ride a signed-in
  // user's session.
  app.register(cors, { origin: env.WEB_URL, credentials: true });

  app.register(cookie);

  // Backed by the same Redis instance as everything else — no separate
  // store to run/monitor for what's a small, low-stakes piece of
  // infrastructure. Global default is generous; auth routes set their own
  // tighter per-route limits (see routes/auth.ts, routes/repositories.ts).
  app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    redis,
  });

  app.register(authPlugin);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "unhandled request error");

    const statusCode = error.statusCode ?? 500;
    reply.code(statusCode).send({
      error: {
        message: statusCode >= 500 ? "Internal Server Error" : error.message,
        statusCode,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
      },
    });
  });

  registerHealthRoute(app);
  registerAuthRoutes(app);
  registerRepositoryRoutes(app);
  registerIngestionRoutes(app);
  registerAnalysisRoutes(app);
  registerEmbeddingRoutes(app);
  registerAIAnalysisRoutes(app);

  return app;
}
