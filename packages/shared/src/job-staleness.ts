/**
 * A run whose status has been "active" (`PENDING`/`QUEUED`/`RUNNING`-equivalent)
 * for longer than a reasonable threshold without progressing is almost
 * certainly orphaned — the worker process that owned it crashed, was
 * killed, or lost its Redis connection mid-job without ever reaching a
 * terminal state. BullMQ's own stalled-job recovery handles the common
 * case (another live `Worker` instance detects and re-processes it), but
 * that requires a worker instance to actually be alive and polling the
 * queue at the right moment — a permanently-down worker, a lost job
 * record, or Redis data loss can all leave a run stuck in an active status
 * forever with nothing to un-stick it.
 *
 * Without this, every one of Ingestion/AnalysisRun/EmbeddingRun/
 * AIAnalysisRun's "an active run already exists" `409` checks
 * (`apps/api/src/routes/{ingestions,analyses,embeddings,ai-analysis}.ts`)
 * would permanently block the user from ever retrying — every "Re-run"
 * click hits the same `409` forever, with no recovery path. Treating a
 * sufficiently stale "active" run as effectively dead (falling through to
 * the normal reuse-the-row path instead of blocking) is a deliberately
 * small, uniform fix across all four pipelines rather than a full
 * stalled-job reaper/cron — see docs/development.md.
 */
export function isStaleActiveRun(updatedAt: Date, thresholdMinutes: number): boolean {
  return Date.now() - updatedAt.getTime() > thresholdMinutes * 60_000;
}
