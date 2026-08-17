/**
 * Name of the session cookie, shared so apps/api (which sets/reads it) and
 * apps/web (which forwards it on server-side requests to the API) never
 * drift out of sync on the literal string.
 */
export const SESSION_COOKIE_NAME = "dp_session";

/** Name of the short-lived cookie holding the pending OAuth `state` value. */
export const OAUTH_STATE_COOKIE_NAME = "dp_oauth_state";

/**
 * Shape returned by GET /auth/me. Intentionally excludes anything
 * sensitive — no GitHub access token, no session token, no secrets.
 */
export interface AuthenticatedUser {
  id: string;
  githubUsername: string;
  githubAvatarUrl: string | null;
}

/** Shape returned by GET /auth/status. */
export interface AuthStatus {
  authenticated: boolean;
  githubConnected: boolean;
}
