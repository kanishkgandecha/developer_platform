# Database

PostgreSQL + [Prisma](https://www.prisma.io/) + [pgvector](https://github.com/pgvector/pgvector).
Schema lives in `packages/database/prisma/schema.prisma`; migrations in
`packages/database/prisma/migrations/`. This document covers what's actually implemented —
the full target schema (analysis runs, findings, code chunks, ...) is sketched in
[architecture.md](./architecture.md) and gets added phase-by-phase, not speculatively up front.

## Implemented models

```
User
 │
 ├── GitHubAccount   (1:1 — a GitHub identity can't be linked to more than one local user)
 ├── Session[]        (opaque-token-hash based; see docs/authentication.md)
 └── Repository[]      (per-user rows — see the note on this in architecture.md)

HealthCheck            (Phase 1 placeholder, proves Prisma ↔ Postgres ↔ pgvector wiring)
```

| Model           | Key fields                                                                 | Notes |
| --------------- | --------------------------------------------------------------------------- | ----- |
| `User`          | `id` (cuid)                                                                   | Identity is entirely GitHub-derived — no email/password. |
| `GitHubAccount` | `userId` (unique), `githubId` (unique), `username`, `avatarUrl`, `accessTokenEncrypted`, `scope` | `accessTokenEncrypted` is AES-256-GCM ciphertext, never plaintext — see [github-integration.md](./github-integration.md#token-security). |
| `Session`       | `userId`, `tokenHash` (unique), `expiresAt`                                    | Stores a SHA-256 hash of the session token, never the token itself. |
| `Repository`    | `userId`, `githubId`, `owner`, `name`, `fullName`, `defaultBranch`, `private`, `htmlUrl`, `description` | `@@unique([userId, githubId])` — scoped per-user, not a global table. Metadata only, no content. |
| `HealthCheck`   | `id`, `checkedAt`                                                              | Phase 1 only; exercised by `GET /health`. |

Every user-owned table (`GitHubAccount`, `Session`, `Repository`) cascades on `User` deletion
(`onDelete: Cascade`) and is indexed on `userId` for the authorization-scoped queries every
protected route runs (never query by a bare `id` — see [authentication.md](./authentication.md)).

## pgvector

Enabled via Prisma's `postgresqlExtensions` preview feature
(`datasource { extensions = [vector] }`), applied by the first migration
(`CREATE EXTENSION IF NOT EXISTS "vector"`). No table uses a `vector` column yet — that lands with
`CodeChunk` in the code-intelligence phase. Verify it's actually installed with:

```bash
docker compose exec postgres psql -U developer_platform -d developer_platform -c '\dx'
```

## Migrations

```bash
pnpm --filter @developer-platform/database exec prisma migrate dev --name <description>   # create + apply locally
pnpm --filter @developer-platform/database exec prisma migrate deploy                      # apply in CI/production
```

Existing migrations are never edited after the fact — schema changes always add a new migration,
even for tables introduced in the same phase (see `packages/database/prisma/migrations/`).
