/**
 * Mirrors the Prisma `EmbeddingRunStatus` enum (packages/database/prisma/schema.prisma).
 * Duplicated here (not imported from @prisma/client) for the same
 * dependency-free reason as AnalysisStatus/IngestionStatus.
 *
 * Deliberately fewer states than AnalysisStatus/IngestionStatus: embedding
 * has no multi-stage breakdown worth surfacing (no PARSING/INDEXING/ANALYZING
 * equivalent) — the worker does everything (download, chunk, diff, embed,
 * persist) under one `EMBEDDING` state. No `CANCELLED` either: nothing in
 * this phase ever sets it (the same is true of the unused `CANCELLED` value
 * on the other two state machines today) and a five-state list is what
 * Phase 5's spec asked for.
 */
export type EmbeddingRunStatus = "PENDING" | "QUEUED" | "EMBEDDING" | "COMPLETED" | "FAILED";

/** States where a job is still queued or actively being processed by the worker. */
export const ACTIVE_EMBEDDING_STATUSES: readonly EmbeddingRunStatus[] = ["PENDING", "QUEUED", "EMBEDDING"];

export function isActiveEmbeddingStatus(status: EmbeddingRunStatus): boolean {
  return (ACTIVE_EMBEDDING_STATUSES as string[]).includes(status);
}

export interface EmbeddingRunDto {
  id: string;
  repositoryId: string;
  analysisRunId: string;
  status: EmbeddingRunStatus;
  error: string | null;
  model: string;
  dimensions: number;
  /** Total chunk candidates found by the chunker this run — `null` until the diff against the previous run has actually happened. */
  chunksDiscovered: number | null;
  /** Chunks whose content hash matched an existing embedded chunk — reused, no embedding API call made. */
  chunksReused: number | null;
  /** Chunks that were actually sent to the embedding provider (new or changed content). Incremented as batches complete — this is the field the "N / total chunks" progress bar polls. */
  chunksEmbedded: number | null;
  /** Chunks from a previous run that no longer exist in the current diff (renamed/removed files, shifted boundaries) and were deleted. */
  chunksDeleted: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One retrieved chunk, normalized for both the search API response and Phase 6's RAG context builder. Keep this shape stable — Phase 6 consumes it directly. */
export interface RetrievalResultDto {
  chunkId: string;
  fileId: string;
  filePath: string;
  symbolName: string | null;
  language: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  /** Cosine similarity (`1 - cosine distance`), 0..1, higher is more similar. */
  semanticScore: number;
  /** `null` when the query produced no lexical matches at all (not the same as a real 0 — see docs/semantic-search.md's hybrid scoring section). */
  lexicalScore: number | null;
  /** Deterministic weighted combination of semanticScore/lexicalScore — see docs/semantic-search.md. This is the sort key. */
  finalScore: number;
}

/**
 * Coarse status the search endpoint reports alongside `results`, so the UI
 * never has to guess *why* a result list is empty (see Phase 5 spec §27 —
 * "no embeddings" / "indexing in progress" / "no results" / etc. must never
 * be conflated into one generic empty state).
 */
export type SemanticSearchStatus = "ready" | "not_indexed" | "indexing" | "not_configured";

export interface SemanticSearchResponse {
  status: SemanticSearchStatus;
  query: string;
  results: RetrievalResultDto[];
}

/**
 * BullMQ queue name — a shared constant so apps/api (producer) and
 * apps/worker (consumer) can't drift on the literal string, same pattern as
 * ANALYSIS_QUEUE_NAME/INGESTION_QUEUE_NAME.
 */
export const EMBEDDING_QUEUE_NAME = "embeddings";

/**
 * Job payload: identifiers only, same constraint as every other queue in
 * this project — no GitHub token, no OpenAI key, no source code ever goes
 * into Redis. The worker re-derives everything else from Postgres/env.
 */
export interface EmbeddingJobPayload {
  embeddingRunId: string;
  repositoryId: string;
  analysisRunId: string;
}
