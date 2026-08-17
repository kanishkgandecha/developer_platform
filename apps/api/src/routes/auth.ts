import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@developer-platform/database";
import type { AuthenticatedUser, AuthStatus } from "@developer-platform/shared";
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from "@developer-platform/shared";
import { env } from "../env.js";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  setOAuthStateCookie,
  setSessionCookie,
} from "../lib/cookies.js";
import { requireAuth } from "../plugins/auth.js";
import { encryptToken } from "../services/crypto.js";
import {
  GitHubApiError,
  buildGitHubAuthorizeUrl,
  exchangeCodeForAccessToken,
  fetchAuthenticatedGitHubUser,
  isGitHubOAuthConfigured,
} from "../services/github.js";
import { createSession, destroySessionByToken } from "../services/session.js";

const callbackQuerySchema = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

/** Every redirect target here is one of our own configured URLs — never built from request input, so there's no open-redirect surface. */
function loginUrlWithError(reason: string): string {
  const url = new URL("/login", env.WEB_URL);
  url.searchParams.set("error", reason);
  return url.toString();
}

// Auth-flow endpoints see abuse (bots hammering the OAuth entry point) more
// than legitimate retraffic — these limits are generous for a real user
// clicking "sign in" a few times, tight enough to blunt scripted abuse.
const AUTH_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
const LOGOUT_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get("/auth/github", { config: { rateLimit: AUTH_RATE_LIMIT } }, async (_request, reply) => {
    if (!isGitHubOAuthConfigured()) {
      return reply.code(503).send({
        error: {
          message:
            "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET to real values — see docs/github-integration.md.",
          statusCode: 503,
        },
      });
    }

    const state = randomBytes(16).toString("hex");
    setOAuthStateCookie(reply, state);
    return reply.redirect(buildGitHubAuthorizeUrl(state));
  });

  app.get(
    "/auth/github/callback",
    { config: { rateLimit: AUTH_RATE_LIMIT } },
    async (request, reply) => {
      const parsed = callbackQuerySchema.safeParse(request.query);
      const expectedState = request.cookies[OAUTH_STATE_COOKIE_NAME];
      clearOAuthStateCookie(reply);

      if (!parsed.success) {
        request.log.warn({ issues: parsed.error.issues }, "malformed OAuth callback request");
        return reply.redirect(loginUrlWithError("invalid_callback"));
      }

      const { code, state, error } = parsed.data;

      if (error) {
        request.log.info({ error }, "user declined GitHub OAuth");
        return reply.redirect(loginUrlWithError("access_denied"));
      }

      // Constant-shape comparison isn't required here (state isn't a secret
      // used for authorization by itself, just CSRF binding) — a plain
      // equality check against the cookie value is the standard mitigation.
      if (!state || !expectedState || state !== expectedState) {
        request.log.warn("OAuth state mismatch — possible CSRF attempt or expired flow");
        return reply.redirect(loginUrlWithError("invalid_state"));
      }

      if (!code) {
        return reply.redirect(loginUrlWithError("missing_code"));
      }

      try {
        const { accessToken, scope } = await exchangeCodeForAccessToken(code);
        const identity = await fetchAuthenticatedGitHubUser(accessToken);

        const githubAccount = await prisma.gitHubAccount.upsert({
          where: { githubId: identity.githubId },
          update: {
            username: identity.username,
            avatarUrl: identity.avatarUrl,
            accessTokenEncrypted: encryptToken(accessToken),
            scope,
          },
          create: {
            githubId: identity.githubId,
            username: identity.username,
            avatarUrl: identity.avatarUrl,
            accessTokenEncrypted: encryptToken(accessToken),
            scope,
            user: { create: {} },
          },
        });

        const session = await createSession(githubAccount.userId);
        setSessionCookie(reply, session.token);

        return reply.redirect(env.WEB_URL);
      } catch (cause) {
        if (cause instanceof GitHubApiError) {
          request.log.error({ err: cause }, "GitHub OAuth exchange failed");
          return reply.redirect(loginUrlWithError("github_unavailable"));
        }
        throw cause;
      }
    },
  );

  app.post(
    "/auth/logout",
    { config: { rateLimit: LOGOUT_RATE_LIMIT } },
    async (request, reply) => {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        await destroySessionByToken(token);
      }
      clearSessionCookie(reply);
      return reply.send({ success: true });
    },
  );

  app.get("/auth/me", { preHandler: requireAuth }, async (request, reply) => {
    // requireAuth already 401'd and short-circuited if request.user is null;
    // this guard is just for TypeScript's narrowing, not a second auth check.
    if (!request.user) {
      return;
    }

    const githubAccount = await prisma.gitHubAccount.findUnique({
      where: { userId: request.user.id },
    });

    const body: AuthenticatedUser = {
      id: request.user.id,
      githubUsername: githubAccount?.username ?? "unknown",
      githubAvatarUrl: githubAccount?.avatarUrl ?? null,
    };
    return reply.send(body);
  });

  app.get("/auth/status", async (request, reply) => {
    let githubConnected = false;

    if (request.user) {
      const githubAccount = await prisma.gitHubAccount.findUnique({
        where: { userId: request.user.id },
        select: { id: true },
      });
      githubConnected = !!githubAccount;
    }

    const body: AuthStatus = { authenticated: !!request.user, githubConnected };
    return reply.send(body);
  });
}
