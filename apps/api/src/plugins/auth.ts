import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { User } from "@prisma/client";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import { getUserForSessionToken } from "../services/session.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated for every request with a valid session cookie; `null` otherwise. */
    user: User | null;
  }
}

/**
 * Resolves `request.user` from the session cookie on every request (cheap:
 * one indexed lookup by token hash). Routes that don't care about auth
 * simply never read it; routes that require it use the `requireAuth`
 * preHandler below rather than re-implementing this check themselves.
 */
const authPlugin: FastifyPluginAsync = async (app) => {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE_NAME];
    request.user = token ? await getUserForSessionToken(token) : null;
  });
};

export default fp(authPlugin, { name: "auth" });

/**
 * preHandler for routes that require authentication. Register per-route
 * (`{ preHandler: requireAuth }`) rather than globally, so public routes
 * (health, the OAuth entry points themselves) aren't accidentally gated.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    reply.code(401).send({ error: { message: "Authentication required", statusCode: 401 } });
  }
}
