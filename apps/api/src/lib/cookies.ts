import type { FastifyReply } from "fastify";
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from "@developer-platform/shared";
import { env } from "../env.js";

/**
 * Shared cookie security posture. `sameSite: "lax"` is what makes the OAuth
 * redirect chain work at all (the callback is a top-level GET navigation
 * from github.com back to us, which SameSite=Strict would drop the cookie
 * for) while still blocking the classic cross-site-form-POST CSRF pattern.
 *
 * Cookies are intentionally host-only (no `Domain` attribute): per
 * RFC 6265, cookie matching ignores port, so a host-only cookie set by the
 * API on `localhost` is also sent on requests to the web app on `localhost`
 * at a different port — which is what our local/Docker Compose setup needs,
 * without widening the cookie to arbitrary subdomains. A real multi-domain
 * production deploy (e.g. app.example.com / api.example.com) needs an
 * explicit shared `Domain` — see docs/deployment.md.
 */
function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
}

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days, matches session.ts's SESSION_TTL_MS
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60; // 10 minutes — just long enough to complete the GitHub redirect

export function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE_NAME, token, {
    ...baseCookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export function setOAuthStateCookie(reply: FastifyReply, state: string): void {
  reply.setCookie(OAUTH_STATE_COOKIE_NAME, state, {
    ...baseCookieOptions(),
    maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
  });
}

export function clearOAuthStateCookie(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: "/" });
}
