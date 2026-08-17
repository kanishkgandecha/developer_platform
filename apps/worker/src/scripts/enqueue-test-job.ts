/**
 * Manual verification helper: enqueues one test job and exits. Used to prove
 * the queue/worker round trip against a live (e.g. docker compose) Redis
 * without needing the full worker process running in the same shell.
 *
 *   pnpm --filter @developer-platform/worker exec tsx src/scripts/enqueue-test-job.ts
 */
import { enqueueTestJob } from "../jobs/test-job.js";
import { closeRedisConnection } from "../connection.js";

const message = process.argv[2] ?? `manual verification @ ${new Date().toISOString()}`;

const job = await enqueueTestJob(message);
console.log(`Enqueued test job ${job.id} with message: "${message}"`);
await closeRedisConnection();
process.exit(0);
