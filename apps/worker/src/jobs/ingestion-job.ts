import type { Job, Worker } from "bullmq";
import { INGESTION_QUEUE_NAME, type IngestionJobPayload } from "@developer-platform/shared";
import { createQueue, createWorker, DEFAULT_JOB_OPTIONS } from "../job-runner.js";
import { logger } from "../logger.js";
import { failIngestion, runIngestion, userFacingMessageFor } from "../ingestion/pipeline.js";

export const ingestionQueue = createQueue<IngestionJobPayload>(INGESTION_QUEUE_NAME);

export async function enqueueIngestionJob(payload: IngestionJobPayload): Promise<Job<IngestionJobPayload>> {
  return ingestionQueue.add(INGESTION_QUEUE_NAME, payload, DEFAULT_JOB_OPTIONS);
}

/**
 * Ingestion is I/O- and disk-bound (network download, filesystem
 * extraction/walk), not CPU-bound, so a small concurrency > 1 is safe and
 * keeps one large repository from blocking every other ingestion behind it.
 */
const INGESTION_CONCURRENCY = 2;

export function startIngestionWorker(): Worker<IngestionJobPayload, void> {
  const worker = createWorker<IngestionJobPayload, void>(
    INGESTION_QUEUE_NAME,
    async (job) => {
      await runIngestion(job.data);
    },
    { concurrency: INGESTION_CONCURRENCY },
  );

  // job-runner.ts's createWorker already logs every failure generically;
  // this listener additionally marks the ingestion row FAILED once BullMQ
  // has genuinely exhausted its retries — not on every intermediate
  // attempt, since an earlier attempt failing doesn't mean the job is done
  // (see pipeline.ts's isPermanentError / transient-error handling).
  worker.on("failed", (job: Job<IngestionJobPayload> | undefined, error: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      void failIngestion(job.data.ingestionId, userFacingMessageFor(error)).catch((cause: unknown) => {
        logger.error({ err: cause, ingestionId: job.data.ingestionId }, "failed to record final ingestion failure");
      });
    }
  });

  return worker;
}
