import type { Env } from "@developer-platform/shared";

async function main(): Promise<void> {
  let env: Env;
  try {
    ({ env } = await import("./env.js"));
  } catch (error) {
    console.error(
      `\n[worker] Failed to start: invalid environment configuration.\n\n${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }

  const { logger } = await import("./logger.js");
  const { checkRedisConnection, closeRedisConnection } = await import("./connection.js");
  const { checkDatabaseConnection } = await import("@developer-platform/database");
  const { startTestWorker } = await import("./jobs/test-job.js");
  const { startIngestionWorker } = await import("./jobs/ingestion-job.js");
  const { startAnalysisWorker } = await import("./jobs/analysis-job.js");
  const { startEmbeddingWorker } = await import("./jobs/embedding-job.js");
  const { startAIAnalysisWorker } = await import("./jobs/ai-analysis-job.js");
  const { startHeartbeat, stopHeartbeat } = await import("./heartbeat.js");

  const redisOk = await checkRedisConnection();
  if (!redisOk) {
    logger.error({ redisUrl: env.REDIS_URL }, "could not connect to Redis, exiting");
    process.exit(1);
  }
  logger.info({ redisUrl: env.REDIS_URL }, "connected to Redis");

  const databaseOk = await checkDatabaseConnection();
  if (!databaseOk) {
    logger.error("could not connect to the database, exiting");
    process.exit(1);
  }
  logger.info("connected to the database");

  const testWorker = startTestWorker();
  const ingestionWorker = startIngestionWorker();
  const analysisWorker = startAnalysisWorker();
  const embeddingWorker = startEmbeddingWorker();
  const aiAnalysisWorker = startAIAnalysisWorker();
  await Promise.all([
    testWorker.waitUntilReady(),
    ingestionWorker.waitUntilReady(),
    analysisWorker.waitUntilReady(),
    embeddingWorker.waitUntilReady(),
    aiAnalysisWorker.waitUntilReady(),
  ]);
  logger.info(
    { queues: [testWorker.name, ingestionWorker.name, analysisWorker.name, embeddingWorker.name, aiAnalysisWorker.name] },
    "worker ready and listening for jobs",
  );

  startHeartbeat();
  logger.info(`worker process started (${env.NODE_ENV})`);

  async function shutdown(signal: string): Promise<void> {
    logger.info(`received ${signal}, shutting down`);
    stopHeartbeat();
    await Promise.all([
      testWorker.close(),
      ingestionWorker.close(),
      analysisWorker.close(),
      embeddingWorker.close(),
      aiAnalysisWorker.close(),
    ]);
    await closeRedisConnection();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
