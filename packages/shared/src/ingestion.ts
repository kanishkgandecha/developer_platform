import type { AnalysisRunDto } from "./analysis.js";

/**
 * Mirrors the Prisma `IngestionStatus` enum (packages/database/prisma/schema.prisma).
 * Duplicated here (not imported from @prisma/client) so packages/web — which
 * never depends on Prisma directly — can use the same literal type.
 *
 * Named `RETRIEVING`, not the more git-flavored `CLONING` some ingestion
 * pipelines use: this project deliberately never runs `git clone` (see
 * docs/repository-ingestion.md) — it downloads a GitHub tarball archive —
 * and a `CLONING` state would misleadingly suggest otherwise.
 */
export type IngestionStatus =
  | "PENDING"
  | "QUEUED"
  | "RETRIEVING"
  | "EXTRACTING"
  | "SCANNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** States where a job is still queued or actively being processed by the worker. */
export const ACTIVE_INGESTION_STATUSES: readonly IngestionStatus[] = [
  "PENDING",
  "QUEUED",
  "RETRIEVING",
  "EXTRACTING",
  "SCANNING",
];

export function isActiveIngestionStatus(status: IngestionStatus): boolean {
  return (ACTIVE_INGESTION_STATUSES as string[]).includes(status);
}

export interface IngestionDto {
  id: string;
  repositoryId: string;
  status: IngestionStatus;
  commitSha: string;
  /** Coarse, milestone-based progress (0–100) — not a precise byte/file count. */
  progress: number;
  error: string | null;
  fileCount: number | null;
  sourceFileCount: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Phase 4 — the ingestion's code-analysis run, if one has been started. `null` means "never analyzed." */
  latestAnalysis: AnalysisRunDto | null;
}

/**
 * BullMQ queue name — a shared constant so apps/api (producer) and
 * apps/worker (consumer) can't drift on the literal string.
 */
export const INGESTION_QUEUE_NAME = "repository-ingestion";

/**
 * Job payload: identifiers only. The worker looks up everything else
 * (repository metadata, the user's encrypted GitHub token) server-side via
 * Postgres — never put a GitHub token or repository contents in a BullMQ
 * job payload, which lives in Redis.
 */
export interface IngestionJobPayload {
  ingestionId: string;
  repositoryId: string;
}
