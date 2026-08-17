import type { Job, Worker } from "bullmq";
import { ANALYSIS_QUEUE_NAME, type AnalysisJobPayload } from "@developer-platform/shared";
import { createQueue, createWorker, DEFAULT_JOB_OPTIONS } from "../job-runner.js";
import { logger } from "../logger.js";
import { failAnalysis, runAnalysis, userFacingMessageFor } from "../analysis/pipeline.js";

export const analysisQueue = createQueue<AnalysisJobPayload>(ANALYSIS_QUEUE_NAME);

export async function enqueueAnalysisJob(payload: AnalysisJobPayload): Promise<Job<AnalysisJobPayload>> {
  return analysisQueue.add(ANALYSIS_QUEUE_NAME, payload, DEFAULT_JOB_OPTIONS);
}

/**
 * Analysis is CPU-bound (AST parsing, rule evaluation) as well as I/O-bound
 * (archive download/extraction), unlike ingestion — kept at the same
 * concurrency as ingestion for now rather than tuned separately, since
 * Phase 4 has no production traffic data yet to tune against.
 */
const ANALYSIS_CONCURRENCY = 2;

export function startAnalysisWorker(): Worker<AnalysisJobPayload, void> {
  const worker = createWorker<AnalysisJobPayload, void>(
    ANALYSIS_QUEUE_NAME,
    async (job) => {
      await runAnalysis(job.data);
    },
    { concurrency: ANALYSIS_CONCURRENCY },
  );

  // Same pattern as jobs/ingestion-job.ts: only mark the row FAILED once
  // BullMQ has genuinely exhausted its retries, not on every attempt.
  worker.on("failed", (job: Job<AnalysisJobPayload> | undefined, error: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      void failAnalysis(job.data.analysisRunId, userFacingMessageFor(error)).catch((cause: unknown) => {
        logger.error({ err: cause, analysisRunId: job.data.analysisRunId }, "failed to record final analysis failure");
      });
    }
  });

  return worker;
}
