import type { Job } from "bullmq";
import { createQueue, createWorker, DEFAULT_JOB_OPTIONS } from "../job-runner.js";
import { logger } from "../logger.js";

/**
 * Not a real analysis job — this exists purely to prove the BullMQ round
 * trip (enqueue -> pick up -> process -> complete) works end-to-end through
 * Docker Compose's Redis. Phase 3+ jobs (repository_ingestion,
 * embedding_generation, the seven agents, ...) follow this exact pattern.
 */
export const TEST_QUEUE_NAME = "test";

export interface TestJobPayload {
  message: string;
  enqueuedAt: string;
}

export interface TestJobResult {
  echoedMessage: string;
  processedAt: string;
}

export const testQueue = createQueue<TestJobPayload>(TEST_QUEUE_NAME);

export async function enqueueTestJob(message: string): Promise<Job<TestJobPayload>> {
  return testQueue.add(
    TEST_QUEUE_NAME,
    { message, enqueuedAt: new Date().toISOString() },
    DEFAULT_JOB_OPTIONS,
  );
}

export function startTestWorker() {
  return createWorker<TestJobPayload, TestJobResult>(TEST_QUEUE_NAME, async (job) => {
    logger.info({ jobId: job.id, payload: job.data }, "processing test job");
    return {
      echoedMessage: job.data.message,
      processedAt: new Date().toISOString(),
    };
  });
}
