# Database

PostgreSQL + [Prisma](https://www.prisma.io/) + [pgvector](https://github.com/pgvector/pgvector).
Schema lives in `packages/database/prisma/schema.prisma`; migrations in
`packages/database/prisma/migrations/`. This document covers what's actually implemented —
the full target schema (embeddings/`CodeChunk`, agent findings history, chat, ...) is sketched in
[architecture.md](./architecture.md) and gets added phase-by-phase, not speculatively up front.

## Implemented models

```
User
 │
 ├── GitHubAccount   (1:1 — a GitHub identity can't be linked to more than one local user)
 ├── Session[]        (opaque-token-hash based; see docs/authentication.md)
 └── Repository[]      (per-user rows — see the note on this in architecture.md)
                         │
                         └── Ingestion[]                      (Phase 3 — one attempt per commit)
                              │
                              ├── RepositoryFile[]              (Phase 3 — metadata only, no content)
                              │    │
                              │    ├── CodeSymbol[]               (Phase 4)
                              │    ├── CodeImport[]                (Phase 4)
                              │    ├── DependencyEdge[] (source/target) (Phase 4)
                              │    ├── CodeMetric[]                 (Phase 4)
                              │    └── Finding[]                     (Phase 4)
                              │
                              └── AnalysisRun?                    (Phase 4 — 1:1 with Ingestion)
                                   │
                                   └── owns the CodeSymbol/CodeImport/DependencyEdge/CodeMetric/Finding
                                       rows above (each also FKs to its RepositoryFile)

HealthCheck            (Phase 1 placeholder, proves Prisma ↔ Postgres ↔ pgvector wiring)
```

### Phase 1–2 — identity and repository access

| Model           | Key fields                                                                 | Notes |
| --------------- | --------------------------------------------------------------------------- | ----- |
| `User`          | `id` (cuid)                                                                   | Identity is entirely GitHub-derived — no email/password. |
| `GitHubAccount` | `userId` (unique), `githubId` (unique), `username`, `avatarUrl`, `accessTokenEncrypted`, `scope` | `accessTokenEncrypted` is AES-256-GCM ciphertext, never plaintext — see [github-integration.md](./github-integration.md#token-security). |
| `Session`       | `userId`, `tokenHash` (unique), `expiresAt`                                    | Stores a SHA-256 hash of the session token, never the token itself. |
| `Repository`    | `userId`, `githubId`, `owner`, `name`, `fullName`, `defaultBranch`, `private`, `htmlUrl`, `description` | `@@unique([userId, githubId])` — scoped per-user, not a global table. Metadata only, no content. |
| `HealthCheck`   | `id`, `checkedAt`                                                              | Phase 1 only; exercised by `GET /health`. |

### Phase 3 — repository ingestion

| Model            | Key fields                                                                 | Notes |
| ---------------- | --------------------------------------------------------------------------- | ----- |
| `Ingestion`      | `repositoryId`, `status` (enum), `commitSha`, `progress`, `error`, `fileCount`, `sourceFileCount`, `startedAt`, `completedAt` | `@@unique([repositoryId, commitSha])` — the idempotency boundary. See [repository-ingestion.md](./repository-ingestion.md). |
| `RepositoryFile` | `ingestionId`, `path`, `name`, `extension`, `language`, `category` (enum), `size`, `isSource`, `isIgnored` | `@@unique([ingestionId, path])`. Metadata only — repository content is never stored. |

### Phase 4 — code intelligence

| Model            | Key fields                                                                 | Notes |
| ---------------- | --------------------------------------------------------------------------- | ----- |
| `AnalysisRun`    | `ingestionId` (unique), `status` (enum), `error`, `filesAnalyzed`, `symbolsFound`, `importsFound`, `findingsCount`, `startedAt`, `completedAt` | `@@unique([ingestionId])` — see [code-intelligence.md](./code-intelligence.md) for why this is *not* idempotently reused the way `Ingestion` reuses a completed commit. |
| `CodeSymbol`     | `analysisRunId`, `fileId`, `name`, `kind` (enum), `startLine`, `endLine`, `exported`, `parentId` (self-relation), `signature`, `complexity`, `parameterCount` | `complexity`/`parameterCount` are `null` for heuristically-parsed languages. |
| `CodeImport`     | `analysisRunId`, `fileId`, `source`, `kind` (enum), `line`, `resolvedFileId` | `resolvedFileId` is only ever set for resolved TS/JS relative imports. |
| `DependencyEdge` | `analysisRunId`, `sourceFileId`, `targetFileId`, `external`, `kind`, `specifier` | The resolved, file-to-file dependency graph — one row per import statement, not deduplicated. |
| `CodeMetric`     | `analysisRunId`, `fileId`, `lineCount`, `codeLineCount`, `commentLineCount`, `blankLineCount`, `functionCount`, `classCount`, `importCount`, `exportCount`, `complexity` | `@@unique([analysisRunId, fileId])`. |
| `Finding`        | `analysisRunId`, `fileId` (nullable), `ruleId`, `severity` (enum), `message`, `line`, `column`, `metadata` (JSON) | Always deterministic rule-engine output — never AI-generated. See [code-intelligence.md](./code-intelligence.md). |

Every user-owned table cascades on `User`/`Repository`/`Ingestion`/`AnalysisRun` deletion
(`onDelete: Cascade`, except `CodeSymbol.parentId` and `CodeImport.resolvedFileId`, which use
`SetNull` — deleting a symbol/file shouldn't cascade-delete every symbol/import that merely
references it) and is indexed on its ownership-scoping foreign key for the authorization-scoped
queries every protected route runs (never query by a bare `id` — see
[authentication.md](./authentication.md)).

## pgvector

Enabled via Prisma's `postgresqlExtensions` preview feature
(`datasource { extensions = [vector] }`), applied by the first migration
(`CREATE EXTENSION IF NOT EXISTS "vector"`). No table uses a `vector` column yet — that lands with
`CodeChunk` in Phase 5 (embeddings + RAG), a separate concern from Phase 4's deterministic code
intelligence above. Verify it's actually installed with:

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
