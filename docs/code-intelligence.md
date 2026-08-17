# Code Intelligence & Static Analysis

Phase 4 turns an already-ingested repository's file metadata into real code intelligence — parsed
symbols, resolved imports, a file-to-file dependency graph, deterministic metrics, and rule-based
findings. **No AI, no LLM calls, no embeddings, no vector search anywhere in this phase** — every
number and finding here is produced by parsing and pattern matching, reproducible, and explainable.
Phase 5 is where an LLM enters the picture, built on top of what this phase persists.

## Architecture

```
Repository ──▶ Ingestion (Phase 3) ──▶ RepositoryFile rows (metadata only)
                                              │
                          "Analyze Code" ─────┤
                                              ▼
                                     POST /repositories/:id/analyses
                                              │
                        1. verify ownership, find the latest COMPLETED ingestion
                        2. reuse (and reset) an existing AnalysisRun for that
                           ingestion, or create one — status QUEUED
                        3. enqueue {analysisRunId, ingestionId}
                                              │
                                     repository-ingestion's sibling queue: code-analysis
                                              │
                                              ▼
                              ┌─────────────────────────────────────┐
                              │ 1. load AnalysisRun + Ingestion +    │
                              │    Repository + owner's GitHub token │
                              │ 2. status → PARSING                  │
                              │ 3. re-download + re-extract the      │
                              │    archive at the ingestion's        │
                              │    already-resolved commit SHA       │
                              │ 4. parse every SOURCE RepositoryFile │
                              │    (AST for TS/JS, heuristic for     │
                              │    Python/Java/C++/Go, metrics-only  │
                              │    for everything else)              │
                              │ 5. status → INDEXING                 │
                              │ 6. persist CodeSymbol/CodeImport/    │
                              │    CodeMetric/Finding rows           │
                              │ 7. status → ANALYZING                │
                              │ 8. build + persist the dependency    │
                              │    graph (DependencyEdge)            │
                              │ 9. status → COMPLETED (or FAILED)    │
                              │ 10. clean up the temporary workspace │
                              └─────────────────────────────────────┘
```

`packages/code-analysis/src/analysis` is the entire deterministic engine — framework-independent
(no Next.js, Fastify, Prisma, BullMQ, Redis, or React import anywhere in it), taking a file's path,
content, and already-classified language, and returning a `ParsedFile` + `CodeMetrics` +
`Finding[]`. `apps/worker/src/analysis/pipeline.ts` is the only thing that touches Postgres, BullMQ,
or the filesystem — the engine itself is pure and independently unit-tested (packages/code-analysis
has 78 tests covering it).

## Why analysis re-downloads the repository (a deliberate tradeoff)

Phase 3's ingestion workspace is deleted the moment ingestion finishes — `RepositoryFile` stores
metadata only, never file content, by design (see [repository-ingestion.md](./repository-ingestion.md)).
Analysis is a separate, later, user-triggered action, so there is no still-open workspace to reuse.

Rather than persisting repository content at rest (which would contradict Phase 3's threat model),
analysis re-downloads the archive at the ingestion's **already-resolved** commit SHA — no new GitHub
API call to re-resolve a branch to a commit, it reuses `Ingestion.commitSha` — and re-extracts it
through the **exact same** secure, size/path-limited pipeline Phase 3 built
(`services/github-archive.ts`, `ingestion/archive.ts`, `ingestion/path-safety.ts`,
`ingestion/workspace.ts` — imported directly into `apps/worker/src/analysis/pipeline.ts`, not
duplicated), into its own ephemeral workspace keyed by the `AnalysisRun`'s own id. The tradeoff:
analysis makes its own GitHub API call and re-pays the download/extraction cost rather than reusing
a still-open workspace. This is intentional and disclosed, not an oversight — see
[repository-ingestion.md](./repository-ingestion.md) for why the workspace can't simply stay open.

**Repository code is never executed** here either — the same guarantee as Phase 3. Parsing means
building/walking a syntax tree (`ts.createSourceFile`, syntax-only — no `ts.createProgram`, no type
checking, no `node_modules`/`.d.ts` resolution) or matching text with regular expressions, never
`eval`, `require`-ing, or shelling out to the repository's own code. No `npm install`, no build
scripts, no git hooks — confirmed by code search (`grep -rn "child_process\|exec(\|spawn(" `) as part
of every security review, not just claimed.

## Language support

| Language | Parser | Symbols/imports | Complexity |
| --- | --- | --- | --- |
| TypeScript, JavaScript | Real AST (`typescript` compiler API) | Full: functions, methods, classes, interfaces, types, enums, variables/constants, all import forms | McCabe cyclomatic complexity per function/method |
| Python, Java, C++/C, Go | Heuristic (regex/line-based) | Best-effort: top-level functions/classes and their imports — see limitations below | Never computed (`null`) |
| Everything else RepositoryFile marks `isSource` | None | Metrics only (LOC/comments/blanks) | `null` |

`ParsedFile.parseStrategy` (`"ast" | "heuristic" | "none"`) is stored and surfaced everywhere, so
nothing downstream ever mistakes a heuristic guess for a real parse.

**Why this split, not five real parsers.** The spec's own escape hatch: "if full parsing for every
language cannot be implemented cleanly within the existing Node/TypeScript architecture, implement
robust TypeScript/JavaScript parsing first and make the other languages metadata-only." Embedding
`tree-sitter` grammars for Python/Java/C++/Go would mean native bindings and native-module Docker
builds for a Node/TypeScript monorepo — real risk for a single phase's scope. TypeScript's own
compiler API is pure JS/TS, needs no native bindings, and already exists as a devDependency
everywhere in this repo, so it does the real work for TS/JS while the other four get honest,
clearly-labeled heuristic extraction instead of a "fake AST."

### Heuristic parser limitations (documented, not hidden)

- Java/C++/Go function and class signatures need their opening `{` on the same line as the
  signature (K&R-ish style) — Allman style (brace on its own line) isn't recognized.
- Multi-line parameter lists aren't recognized — parameter counts and signatures are only extracted
  when the whole `(...)` fits on one line.
- Java/C++ method/function detection is a best-effort `TYPE NAME(...) {` regex; `else if (...)` is
  explicitly excluded (the single most common false-positive shape), not every possible one.
- No complexity is ever computed heuristically — a reliable count needs a real parse tree.
- Import/include statements are recorded for every heuristic language, but never *resolved* to a
  same-repository file (see the dependency graph section) — always `external: true`.

## Symbols, imports, and the dependency graph

`ParsedSymbol` covers `FUNCTION`, `METHOD`, `CLASS`, `INTERFACE`, `TYPE`, `ENUM`, `VARIABLE`,
`CONSTANT`, `MODULE`, each with `startLine`/`endLine`, `exported`, an optional `parentName` (e.g. a
method's enclosing class), a short `signature`, and (TS/JS functions/methods only) `complexity` and
`parameterCount`.

`ParsedImport` covers `IMPORT` (ES import, `export ... from`), `REQUIRE` (`require(...)`),
`DYNAMIC_IMPORT` (`import(...)`), and `INCLUDE` (C/C++ `#include`).

**Dependency resolution is TypeScript/JavaScript-only, relative-import-only.**
`packages/code-analysis/src/analysis/dependency-graph.ts` resolves `./`/`../` specifiers against the
importing file's directory, trying plain extensions (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`)
and `index` files — no tsconfig path-alias resolution (`@/components/...` always comes out
`external: true`, exactly like a real npm package would; this was confirmed against a real
shadcn/ui-style repository during verification — `@/lib/utils`, `@/components/ui/button` etc. all
correctly appear as external, not silently misresolved). Every heuristically-parsed language's
imports are recorded as `CodeImport` rows but never resolved to a target file — always external.

Edges are **not deduplicated** across multiple import statements between the same two files, and
**no transitive closure** is computed — `DependencyEdge` is exactly the direct, per-import-statement
graph, nothing derived from it.

## Deterministic rules (no AI)

Five rules, each independently unit-tested with a positive and a negative case
(`packages/code-analysis/src/analysis/rules`):

| Rule | Fires when |
| --- | --- |
| `COMPLEXITY_HIGH` | A FUNCTION/METHOD's cyclomatic complexity exceeds 10 (AST-parsed languages only) |
| `FILE_TOO_LARGE` | A file exceeds 500 lines |
| `FUNCTION_TOO_LONG` | A FUNCTION/METHOD spans more than 80 lines |
| `TOO_MANY_PARAMETERS` | A FUNCTION/METHOD has more than 5 parameters |
| `TODO_COMMENT` | A `TODO`/`FIXME` marker appears anywhere in the file (every line is scanned for the literal token, not only inside detected comments — simplest, most reliable option, matches how most simple TODO-scanning linters behave) |

Severity is `INFO`/`LOW`/`MEDIUM`/`HIGH`/`CRITICAL`; the size/length/complexity rules scale their
severity by how far over the threshold a file/function is (more than double the limit → `HIGH`,
otherwise `MEDIUM`); `TOO_MANY_PARAMETERS` is always `LOW`; `TODO_COMMENT` is always `INFO`.

**Deliberately not included**: a "dangerous patterns" security rule. The spec's own guidance —
"only implement deterministic patterns that are well-defined and safe... do not claim these are
complete security scanners" — is a caution, not a requirement, and a real one belongs in a dedicated
security-analysis phase, not bolted on here as an afterthought that overclaims what it catches.

Rules are added by implementing `AnalysisRule` (`id`, `description`, `run(context)`) and appending to
`DEFAULT_RULES` — no plugin framework, no dynamic loading.

## Database (see [database.md](./database.md) for the full schema)

`AnalysisRun`, `CodeSymbol`, `CodeImport`, `DependencyEdge`, `CodeMetric`, `Finding` — all added in
Phase 4. Deliberately **extending** `RepositoryFile` (adding back-relations) rather than duplicating
file metadata into a new `CodeFile` model, per the spec's own guidance to reuse what Phase 3 already
persists.

### State machine

```
PENDING → QUEUED → PARSING → INDEXING → ANALYZING → COMPLETED
                                              │
                                              ▼ (any active state)
                                            FAILED
```

Unlike `Ingestion`, `AnalysisRun` has no numeric `progress` column — the named stages are the UI's
only granularity in Phase 4 (no percentage bar). `PARSING` covers the fused retrieval + extraction +
per-file parse (mirrors Ingestion's own retrieval/extraction fusion — see
[repository-ingestion.md](./repository-ingestion.md)); `INDEXING` covers persisting
symbols/imports/metrics/findings; `ANALYZING` covers building and persisting the dependency graph,
which needs every file's imports already known.

### Idempotency — deliberately different from Ingestion's

`AnalysisRun` is unique per `ingestionId` (an ingestion is already pinned to one commit, so there's
no separate "identity" concept the way a commit SHA is for `Ingestion`). But unlike `Ingestion`,
**a `COMPLETED` `AnalysisRun` is never idempotently reused** — every `POST
/repositories/:id/analyses` call re-runs analysis from scratch for the current ingestion (reusing
the same row, clearing its previous `CodeSymbol`/`CodeImport`/`DependencyEdge`/`CodeMetric`/`Finding`
rows first), whether the existing run is `COMPLETED`, `FAILED`, or `CANCELLED`. Only a currently
**active** run (`PENDING`/`QUEUED`/`PARSING`/`INDEXING`/`ANALYZING`) short-circuits with `409`.

This is intentionally not symmetric with Ingestion's "reuse a COMPLETED commit" behavior: re-ingesting
an unchanged commit really is redundant (the source bytes can't have changed), but re-running
*analysis* on an unchanged ingestion is not necessarily redundant — the analysis engine itself (a
rule threshold, a parser fix, a new rule) can change between two requests for the same ingestion.
Treating `COMPLETED` as a idempotent no-op here means clicking "Re-run Code Analysis" would silently
do nothing — this was caught live during verification (see the verification report) and fixed before
Phase 4 was considered done.

BullMQ-level retries (3 attempts, exponential backoff) are reserved for transient failures, same
error-classification split as ingestion: `UnsafeArchivePathError`, `ExtractionLimitError`, and
`GitHubArchiveError` (404/401) are permanent (marked `FAILED` immediately, never retried); everything
else propagates for BullMQ's retry, only marked `FAILED` once attempts are genuinely exhausted.

## API

- `POST /repositories/:id/analyses` — starts (or re-runs/reports) analysis for the repository's
  latest completed ingestion. `409` if there's no completed ingestion yet, or an analysis is already
  active; `201` otherwise (see idempotency note above — this is the one place Phase 4 departs from
  ingestion's convention).
- `GET /repositories/:id/analyses` — ownership-scoped list.
- `GET /analyses/:id` — detail, including a real severity breakdown (`severityCounts`) computed via
  one grouped query — only for this single-resource endpoint, never for list/embedded contexts
  (`IngestionDto.latestAnalysis`), which stay `severityCounts: null` to avoid an extra query per row.
- `GET /analyses/:id/findings` — paginated (`page`/`pageSize`, max 200/page), filterable by
  `severity`/`ruleId`/`fileId`.
- `GET /analyses/:id/files` — per-file metrics plus symbol/import/finding counts (the code explorer's
  file list).
- `GET /analyses/:id/files/:fileId` — one file's symbols (with resolved parent names) and imports —
  the code explorer's file detail view.

Every route requires auth and re-verifies ownership through the `Repository → Ingestion →
AnalysisRun` chain from scratch (never trusting an earlier request) — the same IDOR-safe pattern as
`GET /ingestions/:id`.

## Web UI

A "Code Intelligence" card on the repository detail page (below the existing "Repository Ingestion"
card — deliberately retitled from "Analysis" to avoid colliding with this phase's new, distinct
concept), with an "Analyze Code"/"Re-run Code Analysis" button disabled until the latest ingestion is
`COMPLETED`. On completion: files/symbols/imports/findings counts and a severity breakdown, linking
to `/repositories/:id/analyses/:analysisId` for the full findings table (severity/rule filters,
pagination) and code explorer (a file list; clicking a row fetches and shows that file's symbols and
imports inline). Deliberately not a full code browser or IDE — no source viewer, per the spec's own
scope guidance.

## Known limitations (Phase 4 scope)

- Python/Java/C++/Go get heuristic, not AST-based, extraction — see the language support section.
- Dependency resolution only covers TS/JS relative imports; tsconfig path aliases and every
  non-TS/JS language's imports are recorded but never resolved to a target file.
- No transitive dependency-graph closure, no cross-file deduplication of edges.
- Complexity is never computed for heuristically-parsed languages.
- Rule thresholds are fixed constants (`DEFAULT_RULE_THRESHOLDS`), not yet configurable via
  environment variables or per-repository settings.
- No "dangerous patterns" / security-specific rule yet — deliberately deferred, not attempted.
- The code explorer is file/symbol/import metadata only — no source code viewer.
