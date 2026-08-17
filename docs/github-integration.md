# GitHub Integration

## Creating a GitHub OAuth App (local development)

1. Go to <https://github.com/settings/developers> → **OAuth Apps** → **New OAuth App**.
2. Fill in:
   - **Application name**: anything, e.g. `Developer Platform (local)`
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:4000/auth/github/callback`
     — this must exactly match `API_PUBLIC_URL` + `/auth/github/callback`; if you change
     `API_PUBLIC_URL` in `.env`, update this too.
3. Register the app, then generate a **client secret**.
4. Copy the **Client ID** and **Client Secret** into your `.env`:
   ```
   GITHUB_CLIENT_ID=<your client id>
   GITHUB_CLIENT_SECRET=<your client secret>
   ```
5. Restart the API (`docker compose restart api`, or `docker compose up --build` if you weren't
   already running it).

Without this, `GET /auth/github` responds `503` with a clear message rather than attempting a
doomed redirect — the stack still boots and runs fully otherwise (see `.env.example`'s
placeholder values).

## Requested scope

`read:user repo` (see `GITHUB_OAUTH_SCOPE` in `apps/api/src/services/github.ts`):

- `read:user` — the authenticated user's GitHub identity (id, username, avatar).
- `repo` — repository listing and metadata, including private repositories.

**Note on scope:** GitHub's *classic* OAuth App scopes don't offer a read-only repository grant.
`repo` is the narrowest scope that includes private repository access, and it technically carries
write capability this application never exercises — every GitHub API call this codebase makes is
a read (`GET /user`, `GET /user/repos`; see `apps/api/src/services/github.ts`). A future phase
could move to a GitHub App with fine-grained, genuinely read-only installation permissions to
close this gap; documented here as a known, deliberate trade-off rather than left silent.

## Repository synchronization

```
GitHub API (GET /user/repos, paginated, up to 500 repos)
   ↓
Normalize (apps/api/src/services/github.ts: NormalizedGitHubRepository)
   ↓
Upsert into the Repository table, scoped to the signed-in user
   ↓
Return the synced list
```

Triggered by `POST /repositories/connect`. `GET /repositories` itself just reads whatever's
already persisted (fast, no GitHub call) — this split keeps the expensive/rate-limited operation
explicit rather than implicit on every page load. Metadata only: no repository content is ever
cloned, downloaded, or read. Pagination assumes a user may have hundreds of accessible
repositories (100 per page, capped at 500 total).

## Token security

GitHub access tokens are encrypted at rest with **AES-256-GCM** (authenticated encryption —
tampering with the ciphertext is detected, not silently decrypted into garbage) before being
stored in `GitHubAccount.accessTokenEncrypted`. See `apps/api/src/services/crypto.ts`.

- The encryption key (`GITHUB_TOKEN_ENCRYPTION_KEY`) is a dedicated 32-byte, base64-encoded key,
  separate from `SESSION_SECRET` — validated by the shared env schema
  (`packages/shared/src/env.ts`) so a malformed key fails fast at boot, not on first use.
  Generate a real one with `openssl rand -base64 32`; `.env.example` ships a fixed
  local-dev-only value so `docker compose up` works out of the box — **generate a unique key per
  real environment.**
- The token is decrypted only at the point of use — immediately before a GitHub API call (see
  `POST /repositories/connect` in `apps/api/src/routes/repositories.ts`) — and never logged, never
  returned from any API response, and never sent to the browser.
- `GET /auth/me` and every other endpoint return only `githubUsername`/`githubAvatarUrl` — never
  the token.

## GitHub API client

`apps/api/src/services/github.ts` wraps [`@octokit/rest`](https://github.com/octokit/octokit.js)
for the authenticated-user and repository-listing calls, and a plain `fetch` for the one-time
OAuth code-for-token exchange (simple enough not to need a full client). Responsibilities:

- `exchangeCodeForAccessToken` — OAuth code exchange
- `fetchAuthenticatedGitHubUser` — identity lookup
- `listAuthenticatedRepositories` — paginated repository listing

Every GitHub-facing call has a 10s timeout and maps failures to a single `GitHubApiError` (with a
mapped HTTP status — 401 for an invalid/revoked token, 429 for a GitHub rate limit, 502 for GitHub
being unreachable) so routes never leak GitHub's raw error shape to the client, and never retry
blindly.

## Local setup, end to end

```
1. Create a GitHub OAuth App (above) and copy its credentials into .env
2. docker compose up --build
3. Open http://localhost:3000 — you'll land on /login
4. Click "Continue with GitHub", authorize the app
5. You're redirected back, signed in, and land on the dashboard
6. Open /repositories, click "Sync from GitHub" to pull in your repositories
```
