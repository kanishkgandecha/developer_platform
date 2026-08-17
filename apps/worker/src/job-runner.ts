import { Queue, Worker, type Job, type Processor, type WorkerOptions } from "bullmq";
import { getRedisConnection } from "./connection.js";
import { logger } from "./logger.js";

/**
 * Thin, typed wrapper around BullMQ's Queue so every job type in this
 * project (the Phase 1 test job today; ingestion/embedding/agent jobs from
 * Phase 3 onward) is created the same way, on the same shared connection.
 */
export function createQueue<Payload>(name: string): Queue<Payload> {
  return new Queue<Payload>(name, { connection: getRedisConnection() });
}

/**
 * Thin, typed wrapper around BullMQ's Worker with sane defaults (bounded
 * retries with exponential backoff) and consistent structured logging of
 * job lifecycle events, so individual job definitions only implement the
 * processor function itself.
 */
export function createWorker<Payload, Result = void>(
  name: string,
  processor: Processor<Payload, Result>,
  options: Partial<WorkerOptions> = {},
): Worker<Payload, Result> {
  const worker = new Worker<Payload, Result>(name, processor, {
    connection: getRedisConnection(),
    ...options,
  });

  worker.on("completed", (job: Job<Payload, Result>) => {
    logger.info({ queue: name, jobId: job.id }, "job completed");
  });

  worker.on("failed", (job: Job<Payload, Result> | undefined, error: Error) => {
    logger.error(
      { queue: name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: error },
      "job failed",
    );
  });

  return worker;
}

export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};
