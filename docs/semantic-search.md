# Semantic Search + RAG Foundation

Phase 5 turns an already-ingested, already-analyzed repository into a searchable semantic index:
deterministic chunking of source files (using Phase 4's `CodeSymbol` boundaries where available),
batched OpenAI embeddings, pgvector storage and similarity search, a small deterministic
hybrid-ranking layer, and a RAG context builder. **No AI agents, no chat UI, no LLM-generated
summaries or remediation anywhere in this phase** — every chunk boundary, every hash comparison,
and every ranking score is deterministic and reproducible; the one and only LLM call in this phase
is the OpenAI embeddings API itself, and its output (a vector) is never interpreted or summarized by
another model. Phase 6 is where actual agents consume this retrieval layer.

## Architecture

```
Repository ──▶ Ingestion (Phase 3) ──▶ RepositoryFile rows (metadata only)
                                              │
                    "Analyze Code" (Phase 4) ─┤
                                              ▼
                                     CodeSymbol / CodeImport / Finding
                                              │
                        "Index Repository" ───┤
                                              ▼
                                     POST /repositories/:id/embeddings
                                              │
                1. verify ownership, require a COMPLETED AnalysisRun
                2. verify OPENAI_API_KEY is configured (503 otherwise —
                   never queue a job that's doomed to fail)
                3. reuse (and reset) an existing EmbeddingRun for that
                   analysis run, or create one — status QUEUED
                4. enqueue {embeddingRunId, repositoryId, analysisRunId}
                                              │
                                     sibling queue: embeddings
                                              │
                                              ▼
                      ┌───────────────────────────────────────────┐
                      │ 1. load EmbeddingRun + AnalysisRun +       │
                      │    Repository + owner's GitHub token       │
                      │ 2. status → EMBEDDING                      │
                      │ 3. re-download + re-extract the archive at │
                      │    the ingestion's already-resolved SHA    │
                      │ 4. chunk every SOURCE file (packages/      │
                      │    code-analysis/src/chunking)              │
                      │ 5. diff chunk content hashes against what's │
                      │    already persisted for this run           │
                      │ 6. persist chunksDiscovered/chunksReused/   │
                      │    chunksDeleted immediately (before any    │
                      │    embedding call — real progress denominator)│
                      │ 7. embed only new/changed chunks, batched,   │
                      │    incrementing chunksEmbedded per batch     │
                      │ 8. upsert CodeChunk rows (raw SQL — vector   │
                      │    column), delete stale rows                │
                      │ 9. status → COMPLETED (or FAILED)            │
                      │ 10. clean up the temporary workspace          │
                      └───────────────────────────────────────────┘
                                              │
                                              ▼
                                 pgvector-searchable CodeChunk rows
                                              │
                          POST /repositories/:id/search
                                              │
                    1. verify ownership; embed the query
                    2. pgvector cosine similarity → candidate pool
                    3. deterministic lexical re-scoring
                    4. finalScore = 0.75·semantic + 0.25·lexical
                    5. top-K RetrievalResultDto[]
                                              │
                                              ▼
                                    buildRagContext(results, budget)
                                              │
                                              ▼
                                RagContext (ordered chunks + citations),
                                consumed by Phase 6's agents — never an
                                LLM call inside this function.
```

`packages/code-analysis/src/chunking` (the chunker) and `packages/ai` (the embedding provider
abstraction + RAG context builder + retrieval) are both framework-independent — no Prisma, BullMQ, or
Next.js import in either, though `packages/ai` does depend on `@developer-platform/database` for
Prisma's client + `toVectorLiteral` (see "retrieval" below for why). `apps/worker/src/embedding` is
the only thing that touches the filesystem and GitHub for the embedding side;
`packages/ai/src/retrieval/search.ts` is the only thing that runs the pgvector query — moved here
from `apps/api/src/services/search.ts` in Phase 6 so `apps/worker`'s AI agents could reuse the exact
same retrieval implementation for evidence-gathering rather than a second one being built
(`apps/api/src/routes/embeddings.ts`'s search route now imports it from `@developer-platform/ai`
too) — see [ai-analysis.md](./ai-analysis.md).

## Why chunking reuses Phase 4's `CodeSymbol` boundaries instead of tree-sitter

`docs/architecture.md`'s original forward-looking note sketched tree-sitter-based chunking as the
plan for this phase. Once this phase actually shipped, that plan changed: Phase 4 already produces
real (AST-derived, for TypeScript/JavaScript) or honest heuristic (Python/Java/C++/Go) symbol
boundaries — `CodeSymbol` rows with `startLine`/`endLine`/`parentId` — for every source file an
analysis run touches. Introducing tree-sitter for chunking would mean a second, independent set of
per-language grammars/native bindings solely to re-derive boundaries this codebase already computes
and persists, which is exactly the "native bindings, native-module Docker build risk" tradeoff
Phase 4's own parsing decision explicitly avoided (see
[code-intelligence.md](./code-intelligence.md)). Reusing `CodeSymbol` is simpler, dependency-free,
and consistent for every language Phase 4 already classifies — the tradeoff is that chunk quality
for a file only inherits whatever Phase 4's parser already knows about it (a heuristically-parsed
Python file's chunks are exactly as good as its heuristic symbol extraction, no better).

## Chunking strategy

`packages/code-analysis/src/chunking/chunk-file.ts`'s `chunkFile` is a pure function: given a
file's full source, its language, and its (possibly empty) `CodeSymbol` list, it returns an ordered
array of `CodeChunkCandidate`s. No I/O, no randomness — identical input always produces identical
chunk boundaries and hashes.

1. Every **top-level** symbol (`parentId === null` — a module-level class, function, interface,
   type, enum, or variable/constant) becomes its own region. The gaps between/around them (import
   statements, top-of-file comments, module-level statements Phase 4 didn't turn into a symbol)
   become their own "gap" regions.
2. A region that fits within `maxChars` is one chunk — this is the common case, and it maximizes
   semantic coherence (a whole function or a whole small class, never split).
3. An **oversized** region (e.g. a large class, or a single very long function) first tries its own
   nested symbols as sub-boundaries (a class → its individual methods) before falling back to
   line-based splitting — see `emitRegion`'s two-level nesting cap
   (`MAX_NESTING_DEPTH`). A sub-chunk produced this way keeps citing its enclosing symbol (e.g. every
   piece of an oversized function still carries that function's `symbolId`/`symbolName`), so
   citations stay meaningful even after a forced split.
4. A file with **no symbols at all** (heuristic parser found nothing, or an unsupported/
   non-source language) is treated as one whole-file gap region and still gets sensible line-based
   chunks — never zero chunks just because Phase 4 had nothing structured to say about it (unless
   the file is empty/whitespace-only, which legitimately produces zero chunks).
5. A **trivial gap** between two real symbols (a blank-line separator, a lone import line, shorter
   than `minChars` after trimming) is dropped — never embedded as near-empty, low-signal content.
   This rule is deliberately *not* applied to the sole whole-file fallback region in case 4 — a short
   file is still a legitimate, citable chunk, just not a "trivial gap between two things that
   matter."

### Chunk overlap

Line-based fallback splitting (cases 3 and 4 above) overlaps consecutive sub-chunks by
`CHUNK_OVERLAP_LINES` (default 3) lines, for continuity across an artificial cut. Symbol-boundary
chunks (the common case) get **no** overlap — they're already coherent units; overlapping them would
duplicate a whole function/class across two chunks for no benefit, which is exactly what the spec's
"do not duplicate an entire function into multiple chunks unnecessarily" guidance rules out.

### Character-based sizing, not tokens

`CHUNK_TARGET_CHARS` (default 1600) and `CHUNK_MAX_CHARS` (default 4000) are **character** counts,
not tokens. This is a documented approximation (roughly 4 characters per token for typical source
code) — no tokenizer dependency (e.g. `tiktoken`) was introduced for Phase 5, so chunk sizing is
honestly labeled as character-based rather than falsely claiming token-exact sizing. A minified or
extremely dense single line can still exceed `maxChars` on its own; that line becomes its own chunk
rather than being truncated mid-line (see `splitByLines`'s "always take at least one line" rule).

## Embedding model and dimensions

Default model: `text-embedding-3-small` (configurable via `EMBEDDING_MODEL`). Its native output
width is **1536** dimensions (`EMBEDDING_DIMENSIONS`, default 1536) — this is not guessed; it's
`text-embedding-3-small`'s documented default output size, and it's what the `code_chunk.embedding`
column's fixed-width `vector(1536)` type is built against.

**Changing the embedding model requires a new migration.** `vector(1536)` is a fixed-width Postgres
column type — switching `EMBEDDING_MODEL` to a model with a different native dimension (e.g.
`text-embedding-3-large`, 3072) without also migrating the column and re-embedding everything would
either fail outright (dimension mismatch on insert) or silently produce nonsense similarity scores
if the mismatch somehow went uncaught. `EmbeddingRun.model`/`EmbeddingRun.dimensions` record what was
*actually* used for each run, specifically so a historical run stays honestly labeled even after such
a change.

## Embedding provider abstraction

`packages/ai/src/embedding`:

```ts
interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedDocuments(texts: string[]): Promise<EmbeddingResult[]>;
}
interface EmbeddingResult { vector: number[]; model: string; dimensions: number }
```

One interface, two implementations, no plugin registry:

- `createOpenAIEmbeddingProvider` — the real, default implementation. Batches requests (see below),
  retries transient failures (429/5xx, and connection errors) with exponential backoff (bounded,
  default 3 retries), validates every response (item count, index alignment, vector dimension) before
  trusting it, and throws a typed `EmbeddingProviderError` (with a `retryable` flag) rather than ever
  silently returning fewer/zero/malformed vectors. Accepts an injectable `client` — the test seam
  every unit test in `packages/ai/src/embedding/openai-provider.test.ts` uses instead of a real
  network call.
- `createMockEmbeddingProvider` — deterministic, network-free, used by **every** test in this
  codebase (worker pipeline tests, API search tests) and available for local development without an
  `OPENAI_API_KEY`. Derives a fixed-dimension pseudo-embedding from each text's SHA-256 hash:
  identical input always produces an identical vector, different input reliably produces a different
  one, but the vectors carry **no real semantic meaning whatsoever**. Never used outside tests/local
  dev without credentials — see "known limitations" below for exactly what this does and doesn't
  prove.

`createEmbeddingProviderFromEnv(env)` is the one place "is embedding configured at all?" is decided
— both `apps/worker`'s pipeline and `apps/api`'s search route call it (the latter through
`apps/api/src/services/embedding-provider.ts`, a thin wrapper that exists purely as a test-mocking
seam) instead of each re-implementing the `OPENAI_API_KEY` presence check. Returns `null` (never
throws) when unconfigured.

### Batching

`EMBEDDING_BATCH_SIZE` (default 96) — how many chunk texts go into one `embeddings.create` call.
OpenAI's actual, documented limits: up to 2048 inputs per request, up to 8192 tokens per individual
input, and 300,000 tokens total per request. 96 was chosen (not the 2048 ceiling) as a conservative
default that keeps a typical batch of ~1600-character code chunks comfortably under the total-token
ceiling without needing per-request token accounting — `EMBEDDING_BATCH_SIZE` is configurable if a
deployment's chunk-size profile warrants a different number. The embedding pipeline
(`apps/worker/src/embedding/embed-files.ts`) calls `embedDocuments` once per batch of this size (not
once for the whole repository), which is also what makes the progress bar's "N / total chunks"
increment in real, observable steps rather than jumping from 0 to 100%.

## pgvector

Enabled since Phase 1 (`CREATE EXTENSION IF NOT EXISTS "vector"`), actually used starting here.
`code_chunk.embedding` is `vector(1536)`, added via raw SQL in the Phase 5 migration
(`packages/database/prisma/migrations/20260817123150_add_semantic_search_models/migration.sql`) —
Prisma's schema language has no native `vector` type; `Unsupported("vector(1536)")` in
`schema.prisma` tells `prisma migrate` to preserve the raw SQL type as-is and tells Prisma Client to
exclude the column from its generated read/write types entirely. Every embedding read or write in
this codebase therefore goes through `$queryRaw`/`$executeRaw` with an explicit `::vector` cast —
never the generated client — via `packages/database/src/vector.ts`'s `toVectorLiteral` (the one
place pgvector's `[0.1,0.2,...]` text literal format is built, shared by the worker's writes and the
API's query).

### Distance metric and index

**Cosine distance** (`<=>`, pgvector's cosine-distance operator) throughout — `search.ts`'s query
computes `semanticScore = 1 - (embedding <=> queryVector)`, so `semanticScore` is a similarity in
`[0, 1]` (well, `[-1, 1]` in theory; in practice OpenAI embeddings cluster such that this stays
non-negative), higher is more similar. Cosine was chosen because it's magnitude-invariant — OpenAI's
own documentation recommends cosine similarity for its embeddings, and it's what every other part of
this stack (mock provider tests included) assumes.

**HNSW** (`USING hnsw ("embedding" vector_cosine_ops)`), not IVFFlat: HNSW needs no separate
"training"/list-building step before the index is usable and doesn't degrade as the table keeps
growing incrementally (embeddings arrive run-by-run, not as one bulk load) — exactly this table's
access pattern. `m`/`ef_construction` are left at pgvector's own defaults; Phase 5 has no
production-scale corpus yet to tune them against, and one index (not several competing opclasses) is
enough for this phase's single query shape.

## Incremental embedding — what it covers, and its scope boundary

Every `CodeChunk` has a `contentHash` — SHA-256 over `${filePath}::${chunkIndex}::${content}`. The
identity a re-embed diffs against is `(fileId, chunkIndex)` (the schema's
`@@unique([fileId, chunkIndex])`):

```
freshly chunked candidates
          ↓
existing CodeChunk rows for this embeddingRunId
          ↓
   same (fileId, chunkIndex)?
     ↙            ↘
    yes            no
     ↓              ↓
same contentHash?   new → embed
  ↙      ↘
 yes      no
  ↓        ↓
reuse   changed → embed
(skip API call,
 refresh symbolId
 only)

existing rows whose (fileId, chunkIndex) no longer
appears in the fresh candidates → deleted
```

This is exactly what `apps/worker/test/embedding/embed-files.test.ts` proves against a real
Postgres+pgvector instance: an initial run of N files produces N new embeddings; an immediate
re-run with unchanged content produces zero embedding API calls (and zero rows written — a
"reused" chunk isn't even touched, except a lightweight metadata-only `symbolId` refresh, needed
because a re-*analysis* retry deletes and recreates `CodeSymbol` rows with new ids even when the
underlying code didn't change); changing exactly one file's content produces exactly one new
embedding; a file dropped from the current run's file list has its now-stale chunks deleted, not
left orphaned.

**Scope boundary, stated plainly:** reuse is keyed on `fileId`, and `RepositoryFile` rows are
created fresh per `Ingestion` (a new commit creates entirely new `RepositoryFile` rows, even for
files whose byte content didn't change). So incremental reuse applies to *re-running embedding for
the same ingestion* (the same analysis run re-triggered, or a retried/failed embedding run resumed)
— it does **not** dedupe embeddings across two different commits of the same repository, even when a
file is byte-identical between them. A content-addressed, cross-commit cache (keyed purely on
`contentHash`, independent of `fileId`) would close this gap and is a reasonable future extension,
deliberately not built for Phase 5 — see "known limitations."

## Embedding run model and states

`EmbeddingRun` mirrors `AnalysisRun`'s reuse-by-id relationship with its parent (`AnalysisRun` reuses
the same row across re-runs for one `Ingestion`; `EmbeddingRun` reuses the same row across re-runs
for one `AnalysisRun`, via `@@unique([analysisRunId])`). States: `PENDING`, `QUEUED`, `EMBEDDING`,
`COMPLETED`, `FAILED` — deliberately fewer than `AnalysisRun`'s multi-stage breakdown; there's no
PARSING/INDEXING/ANALYZING-equivalent split worth surfacing, one `EMBEDDING` state covers the whole
download → chunk → diff → embed → persist sequence. The unique-per-analysis-run constraint is also
what makes "prevent multiple active embedding jobs for the same analysis" fall out for free — the
same 409-on-active-row pattern `POST /repositories/:id/analyses` already uses.

`chunksDiscovered`/`chunksReused`/`chunksDeleted` are persisted **as soon as the diff is known**,
before any embedding API call — so the progress UI has a real denominator immediately, not just at
completion. `chunksEmbedded` is incremented **after each batch's vectors are durably persisted**, so
a crash mid-run leaves the count matching exactly what's actually in Postgres, never an optimistic
number ahead of what was really written.

## Retrieval — hybrid semantic + lexical

`packages/ai/src/retrieval/search.ts` (imported by both `apps/api`'s search route and
`apps/worker`'s AI-analysis evidence gathering as of Phase 6):

1. Embed the query with the same provider/model used for chunks.
2. pgvector cosine-similarity query, scoped to `WHERE "repositoryId" = ...` (never filtered after
   the fact — the `WHERE` clause itself is the security boundary, see below), `ORDER BY embedding
   <=> queryVector LIMIT poolSize` — `poolSize = min(limit × 4, 100)`, wide enough that a strong
   lexical match a little further down the pure-semantic ordering still has a chance to surface.
3. `lexicalScoreFor(query, content, symbolName)` — a deterministic score in `[0, 1]`: the fraction
   of the query's identifier-like tokens (split on non-alphanumeric characters, ≥2 characters) that
   appear verbatim (case-insensitive) in the chunk's content or symbol name, with an **exact**
   symbol-name match pinned to `≥ 0.95`. This is what makes a query like `"PatientDashboard"`
   reliably surface the file defining `PatientDashboard` even when a semantically "close" but
   textually unrelated chunk scores nearly as high on cosine similarity alone. Returns `null` (not
   `0`) when the query has no scoreable tokens at all — `finalScore` then falls back to semantic
   score alone, since a lexical score of exactly 0 would otherwise unfairly penalize every candidate
   equally for a query lexical matching was never going to help with.
4. `finalScore = 0.75 × semanticScore + 0.25 × lexicalScore` (or just `semanticScore` when
   `lexicalScore` is `null`) — **fixed weights**, not learned or tunable per request, so results are
   reproducible run to run. Sorted descending by `finalScore`, tiebroken by `semanticScore`, sliced
   to the requested `limit` (max 50).

This is deliberately simple substring matching, not a real tokenizer/stemmer, and not a general
search-ranking framework — see "known limitations."

### Repository-scoped, always

Every retrieval query has `WHERE "repositoryId" = ...` baked directly into the SQL — there is no
code path that queries `code_chunk` without it. Combined with the route-level ownership check
(`Repository.userId === request.user.id`, verified fresh on every request, never trusted from an
earlier one), this is what makes "user A cannot retrieve user B's repository's chunks" hold even if
a chunk id were somehow guessed — the search endpoint never even accepts a chunk id as input, only a
`repositoryId` it independently re-verifies ownership of.

## RAG context assembly

`packages/ai/src/rag/context.ts`'s `buildRagContext(results, budget)` — pure context assembly, **no
LLM call anywhere in this function or this package**. Takes already-ranked `RetrievalResultDto[]`
(trusts the input order rather than re-sorting, so a future re-ranking step upstream is respected)
and a budget (`maxResults`, default 10; `maxCharacters`, default 12,000) and returns:

```ts
interface RagContext {
  chunks: RagContextChunk[];   // ordered, each with a precomputed `citation` string
  totalCharacters: number;     // sum of included chunks' content — always <= budget.maxCharacters
  truncated: number;           // how many candidates the budget left out
}
```

Every `RagContextChunk` carries `filePath`, `symbolName`, `startLine`/`endLine`, and a precomputed
`citation` (e.g. `"src/services/github.ts:90-121"`, or just the file path when no line range is
known) — this is the exact string Phase 6's agents are expected to cite verbatim, computed once here
so every consumer formats citations identically. A chunk that doesn't fit the remaining character
budget is **skipped, never truncated mid-content** — the scan continues past it, so a smaller,
lower-ranked chunk further down the list can still fit and get included; a single oversized chunk
never blocks everything after it.

## API

- `POST /repositories/:id/embeddings` — starts (or reuses/reports) semantic indexing for the
  repository's latest **completed** analysis run. `409` with no completed analysis yet, or an
  embedding run already active; `503` if `OPENAI_API_KEY` isn't configured (never queues a job
  that's doomed to fail); `201` otherwise.
- `GET /repositories/:id/embeddings` — ownership-scoped list, most recent first.
- `GET /embeddings/:id` — single run detail, IDOR-safe (scoped through
  `Repository.userId`, same pattern as every other single-resource route in this codebase).
- `POST /repositories/:id/search` — body `{ query: string, limit?: number }` (limit defaults to 10,
  max 50). Response: `{ status, query, results: RetrievalResultDto[] }`. `status` is one of `ready`,
  `not_indexed`, `indexing`, `not_configured` — every non-`ready` precondition (never configured,
  never indexed, indexing right now) is reported via `status` in a `200` rather than a `4xx/5xx`; the
  request itself was well-formed, the repository just isn't searchable *yet*, and the UI needs to
  tell those apart (never "AI found nothing" for a repository that was never indexed in the first
  place).

Every route requires auth and re-verifies repository ownership from scratch on every request — the
same IDOR-safe pattern every other route file in this codebase already follows.

## Web UI

- A "Semantic Index" card on the repository detail page (below "Code Intelligence"), mirroring
  `AnalysisPanel`'s design: an "Index Repository"/"Re-index Repository" button (disabled until code
  analysis is `COMPLETED`), a real (never simulated) progress bar while `EMBEDDING` — `value` is
  computed from `EmbeddingRun.chunksEmbedded + chunksReused` over `chunksDiscovered`, both fields
  read directly off the polled `EmbeddingRunDto`, and a chunk/embedded/reused/last-indexed summary
  once `COMPLETED`.
- `/repositories/:id/search` — a dedicated Code Search page: a search box, a result list where each
  row shows the similarity score, file path, symbol name, and line range, and expands on click to
  reveal the full chunk content plus its semantic/lexical/final score breakdown. Deliberately not a
  full code browser/IDE.
- Precise empty states, not a generic "AI found nothing": not-configured, not-indexed, indexing, and
  a genuine zero-results state are each their own message (`components/search/semantic-search.tsx`).

## Security

- Repository ownership is re-verified on every embedding/search request, never cached from an
  earlier one.
- Every retrieval query is repository-scoped in the SQL itself (see "retrieval" above) — never
  filtered after the fact.
- The browser never talks to pgvector, and never generates embeddings — every embedding call and
  every vector query happens server-side (`apps/api`, `apps/worker`), same boundary as every other
  piece of repository content in this codebase.
- BullMQ job payloads are identifiers only (`embeddingRunId`, `repositoryId`, `analysisRunId`) — no
  GitHub token, no session token, no API key, no source code ever enters Redis.
- No repository code is ever executed by the embedding pipeline — it reuses Phase 3/4's exact
  download/extraction pipeline (never `git clone`, never `npm install`, never a build/git hook).
- Worker logs report counts (`chunksDiscovered`/`chunksReused`/`chunksEmbedded`/`chunksDeleted`,
  durations, statuses) — never source content, never a chunk's text, never an embedding vector,
  never a token/API key (pino's `redact` config already covers `*.apiKey`/`*.token`/etc.).

## Cost control

- Content-hash-based incremental embedding (see above) — unchanged chunks are never re-sent to
  OpenAI.
- Batched requests (`EMBEDDING_BATCH_SIZE`), not one call per chunk.
- Repository-scoped everywhere — an embedding run only ever processes one repository's files.
- `EMBEDDING_MODEL`/chunk-size knobs are all configurable via environment variables, so a deployment
  can tune cost/quality without a code change.
- Query embedding for search is a single, small call per search request (not batched, since it's
  exactly one text) — the UI searches on submit, not as-you-type, to avoid firing an OpenAI call per
  keystroke.

## Known limitations (Phase 5 scope)

- Incremental embedding is scoped to *re-running embedding within the same ingestion* — it does not
  dedupe embeddings across two different commits of the same repository, even for byte-identical
  files (see "incremental embedding" above for the full explanation).
- Chunk sizing is character-based, not token-exact — no tokenizer dependency was introduced.
- Chunking quality for a heuristically-parsed language (Python/Java/C++/Go) is bounded by Phase 4's
  own heuristic-parser limitations (see [code-intelligence.md](./code-intelligence.md)) — a file
  whose symbols the heuristic parser missed chunks via the line-based fallback instead.
- Hybrid lexical scoring is simple substring/token matching, not a real tokenizer, stemmer, or
  full-text-search engine (e.g. Postgres `tsvector`) — it's good enough to boost exact identifier
  matches, not a general-purpose search-ranking system.
- The candidate pool for hybrid re-ranking is capped (`min(limit × 4, 100)`) — a lexically-strong
  match ranked far outside the top 100 by pure semantic similarity won't be found. This keeps the
  query cheap; a larger corpus may eventually want a wider pool or a proper lexical index.
- `EmbeddingProviderError`'s retry/backoff was verified against an injected fake client (unit tests)
  and the whole persistence pipeline against a real Postgres+pgvector instance using the mock
  provider — **no test in this codebase ever makes a real OpenAI network call**, and this phase's
  own verification did not have a real `OPENAI_API_KEY` available either (see the Phase 5
  verification report for exactly what was and wasn't exercised against real credentials).
- No dedicated RAG-context HTTP endpoint — `buildRagContext` is a library function, ready for
  Phase 6's agents to import directly; exposing it over HTTP wasn't needed by anything in this phase.
- The vector index (`m`/`ef_construction`) is left at pgvector's defaults — untuned, since there's no
  production-scale corpus yet to tune against.
