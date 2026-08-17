import { Queue } from "bullmq";
import { Redis } from "ioredis";
import {
  ANALYSIS_QUEUE_NAME,
  INGESTION_QUEUE_NAME,
  type AnalysisJobPayload,
  type IngestionJobPayload,
} from "@developer-platform/shared";
import { env } from "./env.js";

/**
 * A separate ioredis connection from `./redis.ts`'s — BullMQ requires
 * `maxRetriesPerRequest: null` on any connection it's given (it manages its
 * own retry/backoff semantics), which is incompatible with the general-
 * purpose rate-limiting/health-check connection's settings. Mirrors
 * apps/worker/src/connection.ts's identical constraint.
 */
const queueConnection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

queueConnection.on("error", (error) => {
  if (env.NODE_ENV !== "test") {
    console.error("[queue-redis] connection error:", error.message);
  }
});

const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86400 },
};

/**
 * Producer only — apps/api enqueues ingestion jobs, apps/worker consumes
 * them (apps/worker/src/jobs/ingestion-job.ts). Same queue name, same
 * Redis; no shared in-process state needed between the two.
 */
export const ingestionQueue = new Queue<IngestionJobPayload>(INGESTION_QUEUE_NAME, {
  connection: queueConnection,
});

export async function enqueueIngestionJob(payload: IngestionJobPayload): Promise<void> {
  await ingestionQueue.add(INGESTION_QUEUE_NAME, payload, JOB_OPTIONS);
}

/**
 * Phase 4 — same producer/consumer split as ingestion (apps/worker/src/jobs/analysis-job.ts
 * is the consumer). Payload is identifiers only, same constraint as ingestion.
 */
export const analysisQueue = new Queue<AnalysisJobPayload>(ANALYSIS_QUEUE_NAME, {
  connection: queueConnection,
});

export async function enqueueAnalysisJob(payload: AnalysisJobPayload): Promise<void> {
  await analysisQueue.add(ANALYSIS_QUEUE_NAME, payload, JOB_OPTIONS);
}
