import type { Job, Worker } from "bullmq";
import { AI_ANALYSIS_QUEUE_NAME, type AIAnalysisJobPayload } from "@developer-platform/shared";
import { createQueue, createWorker, DEFAULT_JOB_OPTIONS } from "../job-runner.js";
import { logger } from "../logger.js";
import { failAIAnalysis, runAIAnalysis, userFacingMessageFor } from "../ai-analysis/pipeline.js";

export const aiAnalysisQueue = createQueue<AIAnalysisJobPayload>(AI_ANALYSIS_QUEUE_NAME);

export async function enqueueAIAnalysisJob(payload: AIAnalysisJobPayload): Promise<Job<AIAnalysisJobPayload>> {
  return aiAnalysisQueue.add(AI_ANALYSIS_QUEUE_NAME, payload, DEFAULT_JOB_OPTIONS);
}

/**
 * Low concurrency at the *job* level, deliberately independent of
 * `AI_AGENT_CONCURRENCY` (which bounds concurrency *within* one run, across
 * its six primary agents). Each run already does up to `AI_AGENT_CONCURRENCY`
 * simultaneous OpenAI calls; running two AI-analysis jobs at once would
 * multiply that. Kept at 1 for now — this is genuinely more
 * OpenAI-request-heavy than ingestion/analysis/embedding, and there's no
 * production traffic data yet to tune a higher number against.
 */
const AI_ANALYSIS_CONCURRENCY = 1;

export function startAIAnalysisWorker(): Worker<AIAnalysisJobPayload, void> {
  const worker = createWorker<AIAnalysisJobPayload, void>(
    AI_ANALYSIS_QUEUE_NAME,
    async (job) => {
      await runAIAnalysis(job.data);
    },
    { concurrency: AI_ANALYSIS_CONCURRENCY },
  );

  // Same pattern as jobs/embedding-job.ts: only mark the row FAILED once
  // BullMQ has genuinely exhausted its retries, not on every attempt. In
  // practice runAIAnalysis already resolves to a terminal state
  // (COMPLETED/COMPLETED_WITH_WARNINGS/FAILED) without throwing for
  // per-agent failures — this only fires for a genuinely unexpected error
  // during setup (e.g. a database connectivity blip).
  worker.on("failed", (job: Job<AIAnalysisJobPayload> | undefined, error: Error) => {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      void failAIAnalysis(job.data.aiAnalysisRunId, userFacingMessageFor(error)).catch((cause: unknown) => {
        logger.error({ err: cause, aiAnalysisRunId: job.data.aiAnalysisRunId }, "failed to record final AI analysis failure");
      });
    }
  });

  return worker;
}
