# Authentication

Phase 2 implements GitHub OAuth 2.0 authentication with server-side, database-backed sessions.
There is no email/password login — identity is entirely GitHub-derived.

## OAuth flow

```
Browser                Next.js (web)         Fastify (api)              GitHub
   │                                              │                        │
   │──GET /login, click "Continue with GitHub"────┼───────────────────────▶│
   │                                     (plain <a href> to the API)       │
   │────────────────────────────────GET /auth/github──────────────────────▶│
   │                        (api sets a signed, HttpOnly `state` cookie,   │
   │                         redirects to GitHub's authorize endpoint)     │
   │                                                                       │
   │◀─────────────────────GitHub shows its consent screen──────────────── │
   │                                                                       │
   │────────GET /auth/github/callback?code=...&state=...──────────────────▶│
   │              (api validates `state` against the cookie, exchanges    │
   │               `code` for an access token, fetches the GitHub user,   │
   │               upserts User + GitHubAccount, creates a Session,       │
   │               sets the session cookie, redirects to WEB_URL)         │
   │◀──────────────────────302 → WEB_URL─────────────────────────────────│
```

Everything GitHub-facing happens server-side in `apps/api` (`src/routes/auth.ts`,
`src/services/github.ts`). The client secret, the exchanged access token, and the session
secret never reach the browser or any client-side JavaScript.

## Session design

- The browser holds a single opaque, high-entropy random token (32 bytes, base64url) in an
  `HttpOnly` cookie (`dp_session`, see `packages/shared/src/auth.ts`).
- The database (`Session` table) stores only a **SHA-256 hash** of that token, never the token
  itself — the same principle as password hashing applied to bearer tokens. A database read
  alone can't be used to forge or replay a session.
- Sessions expire 30 days after creation (`apps/api/src/services/session.ts`); logout deletes
  the row server-side (`POST /auth/logout`), so a stolen cookie stops working the moment the
  user logs out, not just when it expires.
- Cookie attributes: `HttpOnly`, `Secure` in production, `SameSite=Lax`, host-only (no `Domain`
  attribute). `SameSite=Lax` is what makes the OAuth redirect chain work at all (GitHub's
  callback is a top-level GET navigation, which `Strict` would drop the cookie for) while still
  blocking classic cross-site-form-POST CSRF. See `apps/api/src/lib/cookies.ts`.
- Adding session refresh or shorter-lived access-token-style sessions later doesn't require an
  architecture change — `createSession`/`getUserForSessionToken`/`destroySessionByToken` are
  the only three functions that would need to change.

## CSRF / OAuth state validation

A random `state` value is generated per login attempt, stored in a short-lived (10 minute),
`HttpOnly` cookie, and also passed to GitHub as the `state` query parameter. On callback, the
API compares the query parameter against the cookie value — a mismatch (or a missing cookie,
e.g. an expired or replayed callback URL) redirects to `/login?error=invalid_state` instead of
proceeding. The state cookie is single-use: cleared immediately on every callback, success or
failure.

## Open redirect prevention

Every redirect target in the auth flow (`/login?error=...` on failure, `WEB_URL` on success) is
built from the server's own configured `WEB_URL` — never from a request parameter, header, or
GitHub's response. There is no `?returnTo=` or similar user-controlled redirect target in Phase 2.

## Middleware

`apps/api/src/plugins/auth.ts` resolves `request.user` (nullable) from the session cookie on
every request via a Fastify `onRequest` hook — cheap (one indexed lookup by token hash), and
routes that don't care about auth simply never read it. Routes that require authentication use
the `requireAuth` preHandler exported from the same file, applied per-route
(`{ preHandler: requireAuth }`), so public routes (`/health`, `/auth/github` itself) are never
accidentally gated. Unauthenticated requests to a protected route get a consistent
`401 { error: { message, statusCode } }` body.

## Web-side protection

Protected pages (`/`, `/repositories`) call `requireUser()` (`apps/web/src/lib/auth.ts`) — a
Server Component helper that calls the API's `GET /auth/me` (forwarding the session cookie) and
redirects to `/login` if it 401s. This — not Next.js middleware peeking at cookie presence — is
the real authorization boundary for pages, mirroring how the API independently re-checks auth on
every protected route regardless of what the page layer does.

Server Components run on the web server, not in the browser, so they don't automatically share
the browser's cookie jar. `apps/web/src/lib/api.ts`'s `serverFetch` reads the incoming request's
session cookie (via `next/headers`) and forwards it by hand on every server-to-API call.

## Token storage

See [github-integration.md](./github-integration.md#token-security).

## Security considerations checklist (Phase 2)

- ✅ CSRF via OAuth `state` (cookie + query param comparison)
- ✅ Open redirect prevention (server-configured targets only)
- ✅ Session fixation: a new session token is issued on every successful login, never reused
- ✅ Cookie security: `HttpOnly`, `Secure` (prod), `SameSite=Lax`
- ✅ IDOR: every repository query is scoped to `userId` from the session, never a client-supplied id
- ✅ Rate limiting on `/auth/github`, `/auth/github/callback`, `/auth/logout`
- ✅ No secrets in logs (pino redaction — see `apps/api/src/logger.ts`) or in API responses
  (`/auth/me` never returns the GitHub access token)
- ✅ GitHub tokens encrypted at rest (AES-256-GCM)
