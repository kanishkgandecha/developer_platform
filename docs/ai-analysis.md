# AI Code Analysis Agents

Phase 6 adds the first AI agents: seven specialized agents that interpret what Phases 4
(deterministic findings) and 5 (semantic retrieval/RAG) already computed, and produce
structured, evidence-cited, confidence-scored findings. This is **analysis only** — no chat,
no autonomous code modification, no code execution, no GitHub PRs, no tool-calling. The AI
agents never rediscover facts the deterministic pipeline already knows (a function's line
count, a file's complexity) — they're handed those facts and asked to interpret, prioritize,
and explain their engineering implications.

## Architecture

```
Repository ──▶ Ingestion ──▶ RepositoryFile
                                  │
              Code Analysis (4) ──┤──▶ CodeSymbol / CodeMetric / Finding
                                  │
              Semantic Index (5) ─┤──▶ CodeChunk (pgvector)
                                  │
                "Run AI Analysis" ┤
                                  ▼
                        POST /repositories/:id/ai-analysis
                                  │
        1. verify ownership, require COMPLETED AnalysisRun + COMPLETED EmbeddingRun
        2. verify OPENAI_API_KEY is configured (503 otherwise — never
           queue a job that's doomed to fail)
        3. reuse (and reset) an existing AIAnalysisRun for that analysis
           run, or create one — status QUEUED
        4. enqueue {aiAnalysisRunId, repositoryId, analysisRunId}
                                  │
                        sibling queue: ai-analysis
                                  │
                                  ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 1. load AIAnalysisRun + AnalysisRun + EmbeddingRun,      │
        │    verify both COMPLETED                                 │
        │ 2. construct the OpenAI chat + embedding providers        │
        │ 3. status → RUNNING; create all 7 AgentRun rows (PENDING) │
        │ 4. run the 6 primary agents with bounded concurrency:     │
        │    for each — gather evidence (deterministic + RAG),      │
        │    call the model for a schema-validated structured        │
        │    output, persist AgentRun + AIFinding rows                │
        │    (a single agent's failure never aborts the others)       │
        │ 5. run the Executive Summary agent over the primary          │
        │    agents' outputs (never its own retrieval)                  │
        │ 6. status → COMPLETED / COMPLETED_WITH_WARNINGS / FAILED       │
        └─────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                 GET /ai-analysis/:id, /:id/agents, /:id/findings, ...
                                  │
                                  ▼
                    AI Analysis panel + detail page (apps/web)
```

`packages/ai/src/agents` (agent specs, prompt/evidence formatting, structured-output
validation) and `packages/ai/src/chat` (the provider abstraction) are framework-independent —
no Prisma, BullMQ, or Next.js import in either. `apps/worker/src/ai-analysis` is the only thing
that touches Postgres/pgvector and orchestrates the run; the agents themselves are pure
functions of `(spec, evidence, provider) → validated output`.

## Core principle: deterministic facts, AI interpretation

Every number an agent cites — a file's line count, a function's complexity, a dependency
edge — comes from Phase 4's already-persisted `CodeMetric`/`Finding`/`DependencyEdge` rows, or
from Phase 5's retrieved `CodeChunk` text, never from the model guessing. The agent's job is
interpretation: explaining engineering impact, prioritizing, and connecting evidence to a
recommendation — not recomputing a count an SQL query already answers exactly. See
`apps/worker/src/ai-analysis/evidence.ts`'s `gatherEvidenceForAgent`, the one place Phase 4/5
data is turned into an `AgentEvidence` object handed to a model.

## The seven agents

A **registry of `AgentSpec` data**, not seven independently-implemented functions — the same
"registry of definitions, not a class hierarchy" pattern Phase 4's rule engine uses
(`packages/code-analysis/src/analysis/rules`). `packages/ai/src/agents/run-agent.ts`'s
`runAgent(spec, evidence, provider)` is the one function all six primary agents run through;
each spec supplies its own title, focus, specific instructions, severity-calibration guidance,
retrieval query, and (optionally) which Phase 4 `Finding.ruleId`s are relevant to it
(`packages/ai/src/agents/specs.ts`).

| # | Agent | Focus | Evidence emphasis |
| - | ----- | ----- | ------------------ |
| 1 | **Architecture** | Modules, layers, service boundaries, dependency direction, coupling | All deterministic findings; retrieval query targets entry points/routing/services |
| 2 | **Code Quality** | Interprets Phase 4's complexity/size/parameter findings, prioritizes them | Scoped to `COMPLEXITY_HIGH`/`FILE_TOO_LARGE`/`FUNCTION_TOO_LONG`/`TOO_MANY_PARAMETERS`/`TODO_COMMENT` |
| 3 | **Security** | Hardcoded secrets, auth gaps, unsafe input handling, dangerous eval, unsafe SQL/deserialization/crypto — static analysis only, never claims certain exploitability | All deterministic findings; retrieval query targets auth/secrets/SQL/eval/crypto |
| 4 | **Performance** | Likely bottlenecks (loops, N+1 patterns, blocking I/O) — never a measured benchmark claim | All deterministic findings; retrieval query targets loops/queries/async patterns |
| 5 | **Dependency Risk** | Coupling, fan-in/fan-out, dependency direction, circular dependencies — only what the real dependency graph shows | All deterministic findings; retrieval query targets imports/exports |
| 6 | **Documentation / Maintainability** | Missing docs around genuinely complex areas, unclear naming, onboarding friction | Scoped to `TODO_COMMENT`/`FILE_TOO_LARGE`/`COMPLEXITY_HIGH`; retrieval query targets public/exported APIs |
| 7 | **Executive Summary** | Synthesizes (never concatenates) the six agents' outputs into overall health, strengths, top risks, next steps | The six agents' own structured outputs — **no retrieval or deterministic data of its own** |

The executive summary agent always runs **after** the other six, and only over whichever of
them actually succeeded — see "partial failure" below. Its `topRisks` reuses the same finding
shape as every other agent, and the prompt explicitly instructs it to copy an underlying
finding's own citations verbatim rather than invent new ones (`packages/ai/src/agents/executive-summary.ts`).

## AI provider abstraction

`packages/ai/src/chat`:

```ts
interface AIProvider {
  readonly provider: string;
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<T>;
}
```

- `createOpenAIChatProvider` — the real implementation. Uses `chat.completions.create` with
  `response_format: zodResponseFormat(schema, schemaName)` (constrains the model's raw JSON
  output server-side), then does its own `JSON.parse` + `schema.safeParse` rather than relying
  on the SDK's auto-parsing convenience method — full control over validation and an injectable
  `client` for tests (same seam as the embedding provider). A malformed JSON body, a
  schema-invalid body, and a transient provider error (429/5xx/connection) are all retried
  (bounded, `AI_AGENT_MAX_RETRIES`, default 2) — retrying the *whole request* (a fresh model
  call), not just the parse step, since the model may simply do better on a second attempt. A
  non-retryable error (401, a malformed request) fails immediately. Never returns unvalidated
  data — either a value that already passed `schema.safeParse`, or a rejected `AIProviderError`.
- `createMockAIChatProvider` — deterministic, network-free, used by **every** test in this
  codebase. Takes a `responder` function per test; still runs the result through the real
  `schema.safeParse`, so a bad test fixture is caught the same way a bad model response would
  be.

`createAIChatProviderFromEnv(env)` is the one place "is AI analysis configured at all?" is
decided — both the worker's pipeline and the API's pre-enqueue check call it (or, for the API,
check `env.OPENAI_API_KEY` directly for the same effect) instead of each re-implementing the
presence check. `OPENAI_API_KEY` is shared with Phase 5's embedding provider — one key
configures both features.

### Model

`OPENAI_MODEL` (default `gpt-4.1-mini`) — a cost-effective, structured-output-capable chat
model; a reasonable default for seven bounded-context calls per repository, not the cheapest or
largest option. Configurable independently of `EMBEDDING_MODEL` — no fixed-width database
column depends on it, so changing it needs no migration (unlike `EMBEDDING_MODEL`, see
[semantic-search.md](./semantic-search.md)).

## Structured output and validation

Every agent response is validated against a Zod schema
(`packages/ai/src/agents/schemas.ts`) before it is ever trusted or persisted:

```ts
AgentFindingSchema = {
  category: string;       // agent-defined free text, e.g. "hardcoded-secret"
  title: string;
  summary: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  confidence: number;     // 0..1, the model's own calibrated confidence
  evidence: string;       // what the retrieved evidence actually shows
  recommendation: string; // what to do about it
  citations: Citation[];  // at least one — see "citations" below
}
AgentOutputSchema = { summary: string; findings: AgentFinding[] } // max 20 findings
ExecutiveSummaryOutputSchema = {
  overallHealth: "EXCELLENT" | "GOOD" | "FAIR" | "POOR" | "CRITICAL";
  summary: string;
  strengths: string[];
  topRisks: AgentFinding[];       // reuses the same shape, same citation rule
  recommendedNextSteps: string[];
}
```

Bounded string lengths and a bounded finding count (max 20 per agent) keep any one agent's
output predictable and keep an agent from "finding" fifty things instead of actually
prioritizing. If the model's response doesn't validate, `createOpenAIChatProvider` retries the
request (bounded); if it's still invalid after retries, that **one agent** is marked `FAILED`
with the validation error as its recorded message — it never corrupts the run, and nothing
invalid is ever written to `AgentRun`/`AIFinding`.

## Citations — never invented

Every finding requires **at least one** citation (`filePath`, `startLine`, `endLine`,
`symbolName` — enforced by the schema, `citations: z.array(CitationSchema).min(1)`), and the
guardrails (below) explicitly instruct the model to copy a citation's file path and line
numbers from the evidence it was actually given, never guess or extrapolate one. The evidence
itself is retrieved **before** the model is ever called (`gatherEvidenceForAgent` →
`searchRepository` + `buildRagContext`, Phase 5's exact retrieval infrastructure, not a second
implementation) — the model only ever sees real, already-retrieved chunks with real citations
attached, so a citation it echoes back is, by construction, a real one.

## Prompt injection defense

Repository content (source code, comments, commit messages, retrieved chunks) is **untrusted
data**, not instructions. `packages/ai/src/agents/guardrails.ts`'s `AGENT_SYSTEM_GUARDRAILS` —
prepended to every agent's system prompt, written once, never duplicated per-agent — states this
explicitly: content that looks like an instruction ("ignore previous instructions...", a fake
system message) must be treated exactly like any other string literal or comment, described or
quoted if relevant, never obeyed.

This is a **structural**, testable property, not just a request to the model:
`packages/ai/src/agents/prompt-injection.test.ts` proves that injected text placed inside
retrieved evidence lands only in the *user* prompt (the data section) and never in the *system*
prompt (the instructions section), and that the system prompt itself is built independently of
evidence content — an injection attempt cannot alter which schema is requested or what the
guardrail text says. What this does **not** claim: that the underlying model is guaranteed to
comply with the guardrails in every case — no prompt-based defense can offer that guarantee.
The two structural facts that hold regardless of model behavior are: the model is never given
tool/shell access (see "AI security" below), so even a successfully "convinced" model can't do
anything beyond returning malformed JSON (which the schema then rejects); and no agent output is
ever trusted without independent schema validation.

## AI security

- **No code execution.** The agents receive text (deterministic evidence + retrieved chunks)
  and return structured JSON — nothing here ever executes repository code, shells out, or runs
  a build/install step. Same guarantee as every earlier phase.
- **No tool-calling.** The model has no function/tool definitions available to it in this phase
  — it cannot invoke anything, query a database, or reach the filesystem. It answers with JSON,
  full stop.
- **Repository content is isolated to the user-prompt data section** — see "prompt injection
  defense" above.
- **Secrets never reach the model or a log.** `OPENAI_API_KEY` is read from environment
  configuration server/worker-side only, never sent as part of a prompt, never logged (pino's
  `redact` config already covers `*.apiKey`/`*.token`/etc. — see "observability" below).
- **IDOR protection** — every `/ai-analysis`/`/repositories/:id/ai-analysis` route re-verifies
  repository ownership from scratch on every request (`repository: { userId }` in the Prisma
  `where` clause, never a bare `id` lookup), the same pattern every route in this codebase
  follows. Proven in `apps/api/test/ai-analysis.test.ts` (userA/userB cross-ownership checks on
  every endpoint).
- **The browser never talks to OpenAI or Postgres directly** — every model call and every
  database query happens server-side (`apps/worker`, `apps/api`).

## Execution model and concurrency

The API **enqueues a job and returns immediately** — the browser never waits on an LLM request
(`POST /repositories/:id/ai-analysis` returns `201` with a `QUEUED` run the moment the job is on
the BullMQ queue). All the actual model calls happen in `apps/worker`.

Two independent concurrency knobs, both bounded (never unlimited parallel OpenAI requests):

- `AI_AGENT_CONCURRENCY` (default 3) — how many of the **six primary agents** run
  simultaneously within one AI analysis run. Enforced by
  `apps/worker/src/ai-analysis/concurrency.ts`'s `mapWithConcurrencyLimit`, a small
  dependency-free worker-pool loop (no new npm package).
- The BullMQ `ai-analysis` queue's own worker concurrency (1) — how many AI analysis *runs*
  (across different repositories) process simultaneously. Kept low since one run can already
  make up to `AI_AGENT_CONCURRENCY` simultaneous OpenAI calls.

The executive summary agent always runs strictly after the six primary agents — it consumes
their outputs, so there is nothing to parallelize it against.

## Partial failure — `COMPLETED_WITH_WARNINGS`

A single agent's failure (exhausted provider retries, a genuinely invalid schema response, an
evidence-gathering error) never aborts the run. Each primary agent's outcome is recorded
independently on its own `AgentRun` row; the run's final status is:

- **`FAILED`** — every primary agent failed; there was nothing to summarize, so the executive
  summary agent is marked `SKIPPED` (not run) and the run itself is `FAILED`.
- **`COMPLETED_WITH_WARNINGS`** — at least one primary agent succeeded, but not all six did, or
  the executive summary agent itself failed. The UI shows exactly which agents succeeded and
  which didn't (`AgentCards`), never masking a partial result as if it were complete.
- **`COMPLETED`** — all seven agents (six primary + executive summary) succeeded.

Proven end-to-end in `apps/worker/test/ai-analysis/pipeline.test.ts` against a real Postgres
database: an all-succeed run, a one-agent-fails run (`COMPLETED_WITH_WARNINGS`, the failed
agent's row and error message verified, the executive summary still synthesizes the remaining
five), and an all-fail run (`FAILED`, executive summary `SKIPPED`).

## Rerun behavior

Mirrors `EmbeddingRun`'s (and, before it, `AnalysisRun`'s) reuse-by-id pattern:
`AIAnalysisRun` is `@@unique([analysisRunId])`. `POST /repositories/:id/ai-analysis`:

- If there's no existing run for the current analysis run, creates one (`QUEUED`).
- If the existing run is currently active (`PENDING`/`QUEUED`/`RUNNING`), returns `409` with
  that run rather than starting a second one — the same "prevent multiple active jobs" rule
  every other queue in this project follows.
- Otherwise (a prior `COMPLETED`/`COMPLETED_WITH_WARNINGS`/`FAILED` run), **reuses the same
  row** — resets its status to `QUEUED`, clears its error/timestamps, and deletes its stale
  `AgentRun` rows (which cascades to their `AIFinding` rows) so a retry never leaves a mix of
  old and new findings behind. The worker then creates fresh `PENDING` `AgentRun` rows for the
  new attempt. This exactly mirrors `POST /repositories/:id/analyses`' "a retry must not leave
  stale rows from a previous attempt behind" rule from Phase 4.

Repository Ingestion, Code Analysis, Semantic Indexing, and AI Analysis are four distinct,
separately-labeled operations in the UI (`IngestionPanel`, `AnalysisPanel`, `EmbeddingPanel`,
`AIAnalysisPanel`) — never conflated, each gated on the previous one's completion.

## Database

```
Repository
  │
  └── Ingestion → AnalysisRun (Phase 4)
                     │
                     ├── EmbeddingRun (Phase 5)
                     │
                     └── AIAnalysisRun?          (Phase 6 — 1:1 with AnalysisRun)
                          │
                          └── AgentRun[]              (one per agent, 7 total)
                               │
                               └── AIFinding[]             (normalized, queryable/filterable)
```

| Model | Key fields | Notes |
| ----- | ---------- | ----- |
| `AIAnalysisRun` | `repositoryId`, `analysisRunId` (unique), `status` (enum), `error`, `provider`, `model`, `startedAt`, `completedAt` | `@@unique([analysisRunId])` — reuse-by-id, mirrors `EmbeddingRun`. `provider`/`model` recorded per-run so a historical run stays honestly labeled even after `OPENAI_MODEL` changes. |
| `AgentRun` | `aiAnalysisRunId`, `agent` (enum, 7 values), `status` (enum), `summary`, `result` (JSON — the full validated structured output), `error`, `startedAt`, `completedAt` | `@@unique([aiAnalysisRunId, agent])` — one row per agent per run, all created `PENDING` up front so "N of 7 complete" is always a real query. |
| `AIFinding` | `agentRunId`, `aiAnalysisRunId` (denormalized), `category`, `title`, `summary`, `severity` (enum), `confidence` (float), `evidence`, `recommendation`, `citations` (JSON array) | Never a single giant JSON blob — findings are normalized rows, independently filterable by severity/agent/confidence. |

Two migrations: `add_ai_analysis_agents` (the three models above) and, immediately after,
`add_ai_finding_evidence_field` — a `evidence` column was missing from the first migration
(caught during implementation, before this phase was reviewed) and added properly as a second
migration rather than editing the first, per this project's own "existing migrations are never
edited after the fact" rule (`docs/database.md`).

**A note on `code_chunk`'s HNSW index**: every migration generated from this point forward
(this phase's two included) shows Prisma's schema-diff engine proposing a
`DROP INDEX "code_chunk_embedding_hnsw_idx"` — it has no way to represent a hand-written
pgvector `USING hnsw (...)` index in `schema.prisma`, so it reads it as drift on every diff.
That line is deliberately removed from every migration file in this phase (documented inline in
each one) — dropping it would silently degrade every vector query back to a full sequential
scan. This will keep happening for any future migration too, and needs the same manual check
each time.

## Cost and rate-limit protection

- Bounded context per agent (`gatherEvidenceForAgent`'s `MAX_LARGEST_FILES`,
  `MAX_RELEVANT_FINDINGS`, `RAG_MAX_RESULTS`/`RAG_MAX_CHARACTERS`) — never "send the whole
  repository."
- Bounded concurrency (`AI_AGENT_CONCURRENCY`) and bounded retries (`AI_AGENT_MAX_RETRIES`) —
  never unlimited parallel requests, never unbounded retry loops.
- Reasonable, cost-effective default model (`gpt-4.1-mini`), configurable.
- No duplicate work: a run's `AgentRun` rows are created once per attempt; a rerun explicitly
  clears stale rows rather than accumulating them.
- No complex cost-accounting system was built (per the spec's own explicit scope guidance) —
  the above structural bounds are what keep a run's cost predictable.

## Observability

Worker logs report `aiAnalysisRunId`, `repositoryId`, `analysisRunId`/`agent`, status, and
duration for every stage. **Never logged**: `OPENAI_API_KEY`, prompt content (which would
include repository source), an agent's raw structured output, access tokens, or session tokens
— pino's `redact` config already covers `*.apiKey`/`*.token`/etc., and no log call in this
phase ever passes a prompt or a finding's full text as a log field (only counts/statuses/ids).

## API

- `POST /repositories/:id/ai-analysis` — starts (or reuses/reports) AI analysis for the
  repository's latest completed analysis run. `409` with no completed code analysis, no
  completed semantic index, or an AI analysis already active; `503` if `OPENAI_API_KEY` isn't
  configured; `201` otherwise.
- `GET /repositories/:id/ai-analysis` — ownership-scoped list, most recent first.
- `GET /ai-analysis/:id` — run detail with a real severity breakdown (once terminal) and every
  agent's brief status.
- `GET /ai-analysis/:id/agents` — every agent, each with its own findings populated (the
  agent-cards view).
- `GET /ai-analysis/:id/findings` — paginated, filterable by `severity`/`agent`/`minConfidence`.
- `GET /ai-analysis/:id/findings/:findingId` — one finding, with its citations and owning agent.

Every route requires auth and re-verifies repository ownership from scratch — the same
IDOR-safe pattern every other route file in this codebase follows.

## Web UI

- An "AI Analysis" panel on the repository detail page (below "Semantic Index"), mirroring
  `EmbeddingPanel`'s design: a "Run AI Analysis"/"Re-run AI Analysis" button (disabled until
  the semantic index is `COMPLETED`), a real (never simulated) agent-completion progress bar
  while `RUNNING`, and a summary once terminal, linking to the full detail page.
- `/repositories/:id/ai-analysis/:analysisId` — the executive summary, a card grid with one
  card per agent (status, summary, finding count — `AgentCards`), and a filterable, paginated,
  expandable findings table (`AIFindingsExplorer`) where every row reveals its evidence,
  recommendation, and citations on click.
- No chat UI, no AI Assistant — deliberately out of scope for this phase.

## Testing

No test in this codebase ever makes a real OpenAI network call — every test uses
`createMockAIChatProvider`/`createMockEmbeddingProvider`. See the final verification report for
exactly what *was* verified against the real OpenAI API (in isolation, outside the full
repository pipeline) and what wasn't.

- **Provider** (`packages/ai/src/chat`): batching N/A (chat, not embeddings) — retries (429/5xx,
  malformed JSON, schema-invalid response), non-retryable errors (401), a per-request
  `maxRetries` override, and the mock provider's "no responder configured" / schema-validation
  behavior.
- **Agents** (`packages/ai/src/agents`): spec sanity (exactly six primary agents, unique types,
  the expected severity-calibration guidance), prompt construction (guardrails + agent-specific
  instructions + real deterministic/RAG evidence present in the prompt, never invented),
  schema enforcement (a finding with zero citations is rejected), the executive summary agent's
  synthesis prompt and partial-input tolerance, and prompt-injection defense.
- **Evidence gathering** (`apps/worker/src/ai-analysis/evidence.ts`): against a real Postgres +
  pgvector database — real deterministic counts/severity breakdown, `relevantRuleIds`
  filtering, and real RAG retrieval bounded and cited correctly.
- **Orchestration** (`apps/worker/src/ai-analysis/pipeline.ts`): against a real database — full
  success, one-agent-failure (`COMPLETED_WITH_WARNINGS`), all-agents-failure (`FAILED`,
  executive summary `SKIPPED`), rerun behavior (stale row cleanup), and concurrency bounding
  (an instrumented provider proves no more than `AI_AGENT_CONCURRENCY` calls overlap).
- **API** (`apps/api/test/ai-analysis.test.ts`, `ai-analysis-not-configured.test.ts`):
  authentication, ownership/IDOR, validation, the `409`/`503` precondition responses, rerun
  (stale-row cleanup verified via a real query), pagination/filtering, and the "not configured"
  `503` path against a real database with `OPENAI_API_KEY` deliberately unset.

## Known limitations (Phase 6 scope)

- No dedicated `overallHealth` field is exposed in the `AgentRunDto`/API response — the
  executive summary agent's `overallHealth` enum lives in its raw `result` JSON but isn't
  surfaced as its own typed API field; the UI shows the synthesized summary text instead. A
  reasonable follow-up, not built here to keep the DTO surface from growing ahead of an actual
  UI need.
- Evidence gathering's retrieval query per agent is a fixed string per `AgentSpec`, not adapted
  to the specific repository's content — a reasonable default, not a tuned-per-repository
  strategy.
- No real OpenAI network call was exercised against a real GitHub repository end-to-end in this
  environment — see the verification report for exactly why and what was verified instead.
- Cost control is structural (bounded context/concurrency/retries), not a metering/budget
  system — per the spec's own explicit "do not implement complex cost accounting yet" guidance.
- `AI_AGENT_CONCURRENCY`/`AI_AGENT_MAX_RETRIES` defaults are reasonable starting points, not
  tuned against real production traffic (none exists yet for this phase).
