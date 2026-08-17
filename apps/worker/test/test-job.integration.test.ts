import { Redis } from "ioredis";
import { QueueEvents } from "bullmq";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { startTestWorker } from "../src/jobs/test-job.js";

/**
 * Exercises the real BullMQ round trip (enqueue -> worker picks up ->
 * completes) against a live Redis. Requires `docker compose up redis` (or
 * the full stack) to be running; skips itself with a clear message
 * otherwise so `pnpm test` stays green without Docker.
 */
async function isRedisAvailable(url: string): Promise<boolean> {
  const probe = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 500,
    retryStrategy: () => null,
  });
  probe.on("error", () => {
    /* expected when Redis isn't running locally; surfaced via the return value below */
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
const redisAvailable = await isRedisAvailable(redisUrl);

describe.runIf(redisAvailable)("test job queue/worker round trip (live Redis)", () => {
  let queueEvents: QueueEvents;
  let worker: Awaited<ReturnType<typeof startTestWorker>>;
  let closeRedisConnection: () => Promise<void>;

  beforeAll(async () => {
    const connectionModule = await import("../src/connection.js");
    closeRedisConnection = connectionModule.closeRedisConnection;
    const { startTestWorker, TEST_QUEUE_NAME } = await import("../src/jobs/test-job.js");

    worker = startTestWorker();
    await worker.waitUntilReady();

    queueEvents = new QueueEvents(TEST_QUEUE_NAME, { connection: { url: redisUrl } });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await queueEvents.close();
    await worker.close();
    await closeRedisConnection();
  });

  it("processes an enqueued job and returns the expected result", async () => {
    const { enqueueTestJob } = await import("../src/jobs/test-job.js");
    const job = await enqueueTestJob("integration-test-message");

    const result = await job.waitUntilFinished(queueEvents, 10_000);

    expect(result).toMatchObject({ echoedMessage: "integration-test-message" });
  });
});

describe.skipIf(redisAvailable)("test job queue/worker round trip (live Redis)", () => {
  it("skipped: Redis is not reachable — run `docker compose up redis` to exercise this", () => {
    /* skipped: no live Redis available for this run */
  });
});
