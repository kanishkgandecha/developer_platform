# Database

PostgreSQL + [Prisma](https://www.prisma.io/) + [pgvector](https://github.com/pgvector/pgvector).
Schema lives in `packages/database/prisma/schema.prisma`; migrations in
`packages/database/prisma/migrations/`. This document covers what's actually implemented —
the full target schema (agent findings history, chat, ...) is sketched in
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
                                   ├── owns the CodeSymbol/CodeImport/DependencyEdge/CodeMetric/Finding
                                   │   rows above (each also FKs to its RepositoryFile)
                                   │
                                   ├── EmbeddingRun?                (Phase 5 — 1:1 with AnalysisRun)
                                   │    │
                                   │    └── CodeChunk[]                (Phase 5 — FKs to RepositoryFile,
                                   │                                    CodeSymbol (nullable), Repository)
                                   │
                                   └── AIAnalysisRun?                (Phase 6 — 1:1 with AnalysisRun)
                                        │
                                        └── AgentRun[]                   (Phase 6 — one per agent, 7 total)
                                             │
                                             └── AIFinding[]                (Phase 6 — normalized findings)

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

### Phase 5 — semantic search + RAG foundation

| Model          | Key fields                                                                 | Notes |
| -------------- | --------------------------------------------------------------------------- | ----- |
| `EmbeddingRun` | `repositoryId`, `analysisRunId` (unique), `status` (enum), `error`, `model`, `dimensions`, `chunksDiscovered`, `chunksReused`, `chunksEmbedded`, `chunksDeleted`, `startedAt`, `completedAt` | `@@unique([analysisRunId])` — reused-by-id across re-embeds of the same analysis run, mirroring `AnalysisRun`'s own relationship with `Ingestion`. |
| `CodeChunk`    | `repositoryId`, `fileId`, `analysisRunId`, `embeddingRunId`, `filePath` (denormalized), `chunkIndex`, `content`, `contentHash`, `startLine`, `endLine`, `symbolId` (nullable), `symbolName` (denormalized), `language`, `charCount`, `embedding` (`vector(1536)`) | `@@unique([fileId, chunkIndex])` — the identity a re-embed diffs `contentHash` against. See [semantic-search.md](./semantic-search.md) for the full incremental-embedding writeup. |

### Phase 6 — AI code analysis agents

| Model | Key fields | Notes |
| ----- | ---------- | ----- |
| `AIAnalysisRun` | `repositoryId`, `analysisRunId` (unique), `status` (enum), `error`, `provider`, `model`, `startedAt`, `completedAt` | `@@unique([analysisRunId])` — reuse-by-id, mirrors `EmbeddingRun`. `provider`/`model` recorded per-run for the same "stay honestly labeled even after config changes" reason as `EmbeddingRun.model`/`dimensions`. |
| `AgentRun` | `aiAnalysisRunId`, `agent` (enum, 7 values), `status` (enum), `summary`, `result` (JSON — full validated structured output), `error`, `startedAt`, `completedAt` | `@@unique([aiAnalysisRunId, agent])` — one row per agent per run, all created `PENDING` up front. |
| `AIFinding` | `agentRunId`, `aiAnalysisRunId` (denormalized), `category`, `title`, `summary`, `severity` (enum), `confidence` (float), `evidence`, `recommendation`, `citations` (JSON array) | Normalized, independently filterable rows — never one giant JSON blob per run. See [ai-analysis.md](./ai-analysis.md) for the full writeup, including a note on a migration mistake (a missing `evidence` column) caught and fixed with a proper follow-up migration rather than editing the first one. |

Every user-owned table cascades on `User`/`Repository`/`Ingestion`/`AnalysisRun` deletion
(`onDelete: Cascade`, except `CodeSymbol.parentId`, `CodeImport.resolvedFileId`, and
`CodeChunk.symbolId`, which use `SetNull` — deleting a symbol/file shouldn't cascade-delete every
symbol/import/chunk that merely references it) and is indexed on its ownership-scoping foreign key
for the authorization-scoped queries every protected route runs (never query by a bare `id` — see
[authentication.md](./authentication.md)).

## pgvector

Enabled via Prisma's `postgresqlExtensions` preview feature
(`datasource { extensions = [vector] }`), applied by the first migration
(`CREATE EXTENSION IF NOT EXISTS "vector"`). Actually used starting Phase 5: `code_chunk.embedding`
is a `vector(1536)` column (`text-embedding-3-small`'s real output width — see
[semantic-search.md](./semantic-search.md)), added via raw SQL (Prisma's schema language has no
native `vector` type — `Unsupported("vector(1536)")` in `schema.prisma` preserves the raw SQL type
and excludes the column from Prisma Client's generated types entirely), with an HNSW index
(`vector_cosine_ops`, matching the `<=>` cosine-distance operator every query in this codebase uses).
Every embedding read/write goes through `$queryRaw`/`$executeRaw`, never the generated client — see
`packages/database/src/vector.ts`. Verify the extension is actually installed with:

```bash
docker compose exec postgres psql -U developer_platform -d developer_platform -c '\dx'
```

## Migrations

```bash
pnpm --filter @developer-platform/database exec prisma migrate dev --name <description>   # create + apply locally
pnpm --filter @developer-platform/database exec prisma migrate deploy                      # apply in CI/production
```

Existing migrations are never edited after the fact — schema changes always add a new migration,
even for tables introduced in the same phase (see `packages/database/prisma/migrations/`). Phase 6
needed two migrations for exactly this reason: the first (`add_ai_analysis_agents`) omitted
`AIFinding.evidence`, caught before this phase was reviewed, fixed with a second migration
(`add_ai_finding_evidence_field`) rather than rewriting the first.

**A recurring gotcha since Phase 5**: every `prisma migrate dev`/`--create-only` run from here on
proposes `DROP INDEX "code_chunk_embedding_hnsw_idx";` in the generated SQL — Prisma's schema-diff
engine has no way to represent the hand-written pgvector `USING hnsw (...)` index (added via raw
SQL in the Phase 5 migration) in `schema.prisma`, so it reads it as drift on every single diff going
forward. That line must be manually removed from the generated migration file before applying it —
dropping it would silently degrade every vector similarity query back to a full sequential scan.
Both Phase 6 migrations hit this and both have it removed, with an explanatory comment in place of
the `DROP INDEX` line.
