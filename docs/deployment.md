# Deployment

Planning-level notes for when this moves beyond local Docker Compose. Nothing here is wired up yet
— Phases 1–3 only target `docker compose up --build` locally.

## Target topology

| Service      | Why                                                              | Reasonable targets                          |
| ------------ | ----------------------------------------------------------------- | -------------------------------------------- |
| `apps/web`   | Stateless Next.js, benefits from edge/CDN caching                 | Vercel, or the same host as api/worker       |
| `apps/api`   | Long-running Fastify process (SSE connections need a live socket) | Fly.io, Railway, Render — not serverless     |
| `apps/worker`| Long-running BullMQ consumer, can't live in a serverless function | Same host family as `apps/api`               |
| PostgreSQL   | Needs the `pgvector` extension enabled                            | Neon, Supabase, or Fly Postgres w/ extension |
| Redis        | Queues, cache, sessions                                           | Upstash, or managed Redis on Fly/Railway     |

`apps/api` and `apps/worker` specifically cannot run as Vercel serverless functions or similar
short-lived compute — they need a persistent process (BullMQ workers block waiting for jobs; SSE
connections stay open for the duration of an analysis run).

## Environment variables in production

Every var in `.env.example` needs a real value in production except the ones explicitly marked
optional/reserved-for-later-phases. `SESSION_SECRET` and `GITHUB_TOKEN_ENCRYPTION_KEY` in
particular must be strong, unique values per environment — generate both with
`openssl rand -base64 32`, never reuse the dev placeholders. `GITHUB_CLIENT_ID`/
`GITHUB_CLIENT_SECRET` need a **separate GitHub OAuth App per environment** (its callback URL is
environment-specific — see below), not the same app reused across dev/staging/prod.

## GitHub OAuth in production

- Register a distinct GitHub OAuth App per environment, with **Authorization callback URL** set to
  `<API_PUBLIC_URL>/auth/github/callback` for that environment (e.g.
  `https://api.example.com/auth/github/callback`).
- `WEB_URL` and `API_PUBLIC_URL` must be the real public HTTPS URLs — the post-login redirect and
  the OAuth callback URL are both built directly from them (never from request headers).
- Session cookies are set `Secure` automatically once `NODE_ENV=production`, so both `apps/web`
  and `apps/api` must be served over HTTPS.

## Cross-origin cookies in production (important, not yet solved generically)

Locally, `apps/web` (`localhost:3000`) and `apps/api` (`localhost:4000`) are different **ports**
of the same **host** (`localhost`) — cookies ignore port in their matching rules, so a host-only,
`SameSite=Lax` cookie set by the API is automatically usable from the web app too (see
[authentication.md](./authentication.md)). In a real deployment, `apps/web` and `apps/api` are
typically on genuinely different **hosts** (e.g. `app.example.com` / `api.example.com`), which are
only **same-site** (and therefore cookie-compatible without extra work) if they share a
registrable parent domain and the cookie is explicitly scoped with `Domain=.example.com`.
Deploying `apps/web` and `apps/api` under unrelated domains (e.g. Vercel's default
`*.vercel.app` for web and a separate Fly.io domain for the API) would break session cookies
entirely and needs either a shared parent domain + explicit `Domain` cookie attribute, or a
reverse proxy unifying both under one origin — not yet implemented, tracked here rather than
hidden.

## Repository ingestion and analysis (worker) disk in production

Each ingestion — and, as of Phase 4, each code-analysis run, which re-downloads and re-extracts the
same archive into its own workspace (see [code-intelligence.md](./code-intelligence.md) for why) —
writes a temporary, per-run workspace to local disk (`INGESTION_WORKSPACE_DIR`, shared by both
queues, see [repository-ingestion.md](./repository-ingestion.md)) and deletes it when the job
finishes. It's ephemeral by design — no persistent volume is required, and none should be mounted (a
crashed worker leaving orphaned workspace directories behind is a disk-quota concern, not a
data-loss one, since nothing durable lives there). Whatever host runs `apps/worker` needs enough
local/ephemeral disk headroom for `MAX_REPOSITORY_SIZE_MB` times the combined concurrency of *both*
queues (2 + 2 by default = 4 simultaneous extractions worst case, since ingestion and analysis run
as independent BullMQ workers in the same process), plus normal margin — tune
`MAX_REPOSITORY_SIZE_MB`/`MAX_FILES_PER_REPOSITORY` for production traffic rather than reusing the
local-dev defaults unchanged.

## Not yet solved (tracked for the phase that needs it)

- CI/CD pipeline (build/test/deploy on push) — Phase 9/10.
- Database migrations in production (`prisma migrate deploy` as a release step, not `migrate dev`).
- Secrets management (currently plain env vars; a real deploy should use the target platform's
  secret store rather than committing even a filled-in `.env`).
- Cross-domain session cookies (see above).
- Observability backend (Prometheus/Grafana or a hosted alternative) — Phase 9.
