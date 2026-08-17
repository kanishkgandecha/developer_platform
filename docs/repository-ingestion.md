# Repository Ingestion

Phase 3 turns a connected GitHub repository into scanned, classified file metadata — the
foundation later phases (chunking, embeddings, RAG, AI agents) build on. This phase deliberately
stops at metadata: no file content is parsed, no code is analyzed, no AI is involved.

## Architecture

```
Browser                Next.js (web)        Fastify (api)              Postgres        Redis           Worker
   │                                              │                                                        │
   │──"Analyze Repository"───────────────────────▶│                                                        │
   │                              POST /repositories/:id/ingestions                                        │
   │                                              │                                                        │
   │                              1. verify ownership                                                      │
   │                              2. resolve current HEAD commit SHA (GitHub API, lightweight)              │
   │                              3. reuse an existing COMPLETED/active ingestion at that SHA, or:          │
   │                                 create an Ingestion row (status QUEUED) ─────────────────▶│            │
   │                                 enqueue {ingestionId, repositoryId} ──────────────────────────────────▶│
   │◀─────────────────────────────201 { ingestion }                                                         │
   │                                                                                                        │
   │  (client polls GET /ingestions/:id every 2s while active)                                              │
   │                                                                                                        │
   │                                                                          repository-ingestion queue    │
   │                                                                                          │             │
   │                                                                                          ▼             │
   │                                                              ┌─────────────────────────────────────┐  │
   │                                                              │ 1. load Ingestion + Repository +     │  │
   │                                                              │    owner's encrypted GitHub token    │  │
   │                                                              │ 2. decrypt token (server-side only)  │  │
   │                                                              │ 3. status → RETRIEVING               │  │
   │                                                              │ 4. download + extract archive         │  │
   │                                                              │    (streamed, never buffered whole)   │  │
   │                                                              │ 5. status → EXTRACTING → SCANNING     │  │
   │                                                              │ 6. walk + classify files              │  │
   │                                                              │ 7. persist RepositoryFile rows        │  │
   │                                                              │ 8. status → COMPLETED (or FAILED)     │  │
   │                                                              │ 9. clean up temporary workspace       │  │
   │                                                              └─────────────────────────────────────┘  │
```

The API never downloads or touches repository content — it only creates the `Ingestion` row and
enqueues a job. All the heavy work (network download, extraction, filesystem walk) happens in
`apps/worker`, matching the split established in Phase 1 (long-running work never happens inside
an HTTP request).

## GitHub retrieval — tarball, never `git clone`

`apps/worker/src/services/github-archive.ts` downloads
`GET https://api.github.com/repos/{owner}/{repo}/tarball/{sha}` (which GitHub's API redirects to
`codeload.github.com`) with the repository owner's decrypted access token, and streams the
response body directly into extraction — never buffered whole into memory.

This project never runs `git clone`. A real clone can execute `.git` hooks and requires a git
binary; a tarball download is simpler, needs no local git, and has no hook-execution surface at
all. This is also why the ingestion state machine uses `RETRIEVING`, not the more common
`CLONING` — the label should describe what's actually happening.

The GitHub access token is:
- obtained server-side only, by decrypting `GitHubAccount.accessTokenEncrypted`
  (`apps/worker/src/services/crypto.ts`, sharing the AES-256-GCM implementation in
  `packages/shared/src/crypto.ts` with `apps/api`) — the browser never sees it
- never put in the BullMQ job payload (which lives in Redis) — the payload is just
  `{ ingestionId, repositoryId }`; the worker looks up everything else itself
- never logged, in any structured log line

## Security model — repository contents are untrusted input

**Repository code is never executed**, anywhere in this pipeline. No `npm install`, no build
scripts, no shell scripts, no git hooks, no Dockerfiles. The pipeline only ever reads archive
bytes and writes plain files to a temporary workspace.

`apps/worker/src/ingestion/archive.ts` is the untrusted-input boundary:

- **Path traversal / absolute paths**: every archive entry's path is independently re-validated
  by `resolveSafeEntryPath` (`path-safety.ts`) — resolved against the workspace directory and
  rejected if it doesn't land inside it. This is checked ourselves, not just delegated to the
  `tar` library's own protections (belt and suspenders for the highest-stakes correctness area in
  this phase).
- **Symlinks / hard links**: never extracted, full stop — a symlink could point outside the
  workspace and get silently followed later during scanning.
- **Per-file size cap** (`MAX_FILE_SIZE_MB`, default 10): an oversized individual file is skipped
  (not extracted, not truncated) rather than filling the disk. Its existence still isn't recorded
  either, since it's never written — this only protects disk space for genuinely huge assets.
- **Cumulative size cap** (`MAX_REPOSITORY_SIZE_MB`, default 500) and **file count cap**
  (`MAX_FILES_PER_REPOSITORY`, default 5000): once either is exceeded, remaining entries are
  skipped and the whole ingestion fails afterward — a repository over the limit never gets
  partially trusted as "done." All three limits are configurable via environment variables (see
  `.env.example`).
- **Malformed archives**: a non-tar/corrupt stream fails extraction cleanly (the extractor's
  `error` event rejects the promise) rather than hanging.

## File classification (`packages/code-analysis`)

Extension- and filename-based only — "do not attempt sophisticated language detection yet."
Three centralized modules, each independently testable and easy to extend for Phase 4:

- `ignore-rules.ts` — directory names pruned entirely during the walk (`node_modules`, `.git`,
  `.next`, `dist`, `build`, `coverage`, `.cache`, `venv`, `.venv`, `__pycache__`, `target`,
  `vendor`). Their contents are never stat'd, classified, or turned into rows — this is as much a
  volume control (`node_modules` alone can be hundreds of thousands of files) as a relevance one.
- `language-map.ts` — extension → language for `SOURCE` files (TypeScript, JavaScript, Python,
  Java, C, C++, Go, Rust, Ruby, PHP, C#, Kotlin, Swift, HTML, CSS, SQL, Shell).
- `classify.ts` — the full category decision (`SOURCE`, `CONFIG`, `DOCUMENTATION`, `DATA`,
  `BINARY`, `GENERATED`, `IGNORED`), checking known filenames (`package.json`, lockfiles, `README`,
  ...) before falling back to extension rules, and finally to `DATA` for anything unrecognized
  (counted, never silently dropped, never guessed to be source).

`apps/worker/src/ingestion/scan.ts` walks the already-safely-extracted workspace (everything on
disk was already validated during extraction) and classifies every file it finds.

## Ingestion state machine

```
PENDING → QUEUED → RETRIEVING → EXTRACTING → SCANNING → COMPLETED
                                                   │
                                                   ▼ (any active state)
                                                 FAILED

PENDING/QUEUED → CANCELLED   (state exists in the schema; not yet exposed via an API endpoint)
```

Every transition is owned by `apps/worker/src/ingestion/pipeline.ts` — the API only ever creates
the initial row. Progress (`Ingestion.progress`, 0–100) is coarse and milestone-based, not
precise: 0 queued, 10 after a confirmed live stream from GitHub, 30 once the fused
download+extract step finishes (they're streamed together — see below — so there's no
independent checkpoint between them), 50 once scanning starts, 80 once metadata is persisted, 100
on completion.

**Why retrieval and extraction share one progress jump (10% → 30%) instead of two:** the archive
is piped directly from the HTTP response into the tar extractor (`archiveStream.pipe(extractor)`)
so the whole repository is never buffered into memory — see
[Performance](#performance-and-observability). That efficiency means there's no clean
"download finished, now extracting" boundary to report progress at.

## Idempotency and retries

**Commit SHA is the identity boundary** (`@@unique([repositoryId, commitSha])` on `Ingestion`).
`POST /repositories/:id/ingestions` resolves the repository's current default-branch HEAD SHA
(a lightweight GitHub API call, not the archive download) before deciding what to do:

- an ingestion already `COMPLETED` at that SHA → reused, returned as-is (200), no new job
- an ingestion already active (`QUEUED`/`RETRIEVING`/`EXTRACTING`/`SCANNING`) at that SHA → `409`,
  with the existing ingestion attached so the client can start watching it instead
- an ingestion `FAILED`/`CANCELLED` at that SHA → the **same row** is reset to `QUEUED` and a new
  job enqueued (a retry reuses the row rather than accumulating failed attempts as separate ones)
- no ingestion at that SHA yet → a new row is created

**BullMQ-level retries** (3 attempts, exponential backoff) are reserved for genuinely transient
failures — a network blip, GitHub being briefly unreachable. `pipeline.ts` classifies errors:
a hostile/malformed archive, a 404/401 from GitHub, or a size/count limit being exceeded are
**permanent** — marked `FAILED` immediately and never retried, since retrying can't fix any of
them. Everything else propagates and lets BullMQ retry; only once BullMQ's attempts are
genuinely exhausted (checked in `apps/worker/src/jobs/ingestion-job.ts`'s `failed` handler) does
the ingestion get marked `FAILED`.

## Temporary workspace

Each ingestion gets an isolated directory: `${INGESTION_WORKSPACE_DIR}/${ingestionId}/`
(`apps/worker/src/ingestion/workspace.ts`). `INGESTION_WORKSPACE_DIR` defaults to `./workspaces`,
resolved against the worker process's cwd — `/app/workspaces` inside Docker (the worker's `WORKDIR`
is `/app`), `apps/worker/workspaces` for local `pnpm dev`, with no per-environment override needed.

The workspace is deleted in a `finally` block — on success **and** on failure, always. A cleanup
failure is logged and swallowed, never thrown and never exposed to the user (no filesystem path
ever appears in an API response or the UI) — a disk-cleanup hiccup shouldn't turn an otherwise
successful ingestion into a reported failure, and must never crash the worker process.

## Performance and observability

- The archive is streamed from the HTTP response straight into the tar extractor — never
  `Buffer`-loaded whole into memory, regardless of repository size (bounded instead by the size
  caps above).
- Repository content is never sent through the API, never stored in Redis, never stored in
  Postgres — only file *metadata* (`RepositoryFile`) is persisted, via a single batched
  `createMany` call per ingestion.
- Every worker log line includes `ingestionId`/`repositoryId` (and, from BullMQ, `jobId`) for
  correlation, at each real milestone (`repository ingestion started`, `repository extraction
  completed`, `repository scan started/completed`, `repository ingestion completed/failed`).
  Never logged: the GitHub access token, the session token, or file/repository *content*.

## Known limitations (Phase 3 scope)

- Progress is polled by the client (`GET /ingestions/:id` every 2s while active), not pushed —
  this project doesn't have SSE/WebSocket infrastructure yet; that's planned for the job-system
  phase in [architecture.md](./architecture.md)'s roadmap.
- `CANCELLED` exists in the schema but has no API endpoint yet — an ingestion can't be cancelled
  mid-flight in Phase 3.
- File classification is extension/filename-based only, not content-sniffed — an unusual or
  misleadingly-named file can be misclassified. Acceptable for Phase 3's scope; a non-issue since
  nothing downstream trusts the classification for anything security-sensitive yet.
