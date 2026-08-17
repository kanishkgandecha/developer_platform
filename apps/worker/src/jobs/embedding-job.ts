import type { Job, Worker } from "bullmq";
import { EMBEDDING_QUEUE_NAME, type EmbeddingJobPayload } from "@developer-platform/shared";
import { createQueue, createWorker, DEFAULT_JOB_OPTIONS } from "../job-runner.js";
import { logger } from "../logger.js";
import { failEmbedding, runEmbedding, userFacingMessageFor } from "../embedding/pipeline.js";

export const embeddingQueue = createQueue<EmbeddingJobPayload>(EMBEDDING_QUEUE_NAME);

export async function enqueueEmbeddingJob(payload: EmbeddingJobPayload): Promise<Job<EmbeddingJobPayload>> {
  return embeddingQueue.add(EMBEDDING_QUEUE_NAME, payload, DEFAULT_JOB_OPTIONS);
}

/**
 * I/O-bound (archive download, an external OpenAI call per batch) more than
 * CPU-bound — kept at the same concurrency as ingestion/analysis for now,
 * same "no production traffic data yet to tune against" reasoning as
 * apps/worker/src/jobs/analysis-job.ts.
 */
const EMBEDDING_CONCURRENCY = 2;

export function startEmbeddingWorker(): Worker<EmbeddingJobPayload, void> {
  const worker = createWorker<EmbeddingJobPayload, void>(
    EMBEDDING_QUEUE_NAME,
    async (job) => {
      await runEmbedding(job.data);
    },
    { concurrency: EMBEDDING_CONCURRENCY },
  );

  // Same pattern as jobs/analysis-job.ts: only mark the row FAILED once
  // BullMQ has genuinely exhausted its retries, not on every attempt.
  worker.on("failed", (job: Job<EmbeddingJobPayload> | undefined, error: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      void failEmbedding(job.data.embeddingRunId, userFacingMessageFor(error)).catch((cause: unknown) => {
        logger.error({ err: cause, embeddingRunId: job.data.embeddingRunId }, "failed to record final embedding failure");
      });
    }
  });

  return worker;
}
