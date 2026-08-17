import { Redis } from "ioredis";
import { env } from "./env.js";

/**
 * Single shared ioredis connection for the API process (rate limiting,
 * caching, and — indirectly — the connection options worker jobs are
 * enqueued with, once Phase 2+ adds business endpoints that enqueue jobs).
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// ioredis emits 'error' as a regular EventEmitter event; with no listener,
// Node logs an "Unhandled error event" for every failed connection attempt
// (e.g. Redis briefly unreachable during startup). checkRedisConnection()
// already surfaces failures to its caller, so this listener just prevents
// that duplicate, unstructured noise — actual errors still show up via the
// /health response and, for anything unexpected, get logged once here.
redis.on("error", (error) => {
  if (process.env.NODE_ENV !== "test") {
    console.error("[redis] connection error:", error.message);
  }
});

/**
 * Cheap connectivity check used by /health. Uses a short timeout so a dead
 * Redis doesn't hang the health check itself.
 */
export async function checkRedisConnection(): Promise<boolean> {
  try {
    if (redis.status === "wait" || redis.status === "end") {
      await redis.connect();
    }
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

const WORKER_HEARTBEAT_KEY = "worker:heartbeat";

/**
 * True if apps/worker has written a heartbeat to Redis within its own TTL
 * (see apps/worker/src/heartbeat.ts) — the key simply won't exist once it
 * expires, so "missing" and "stale" are the same case here.
 */
export async function checkWorkerHeartbeat(): Promise<boolean> {
  try {
    return (await redis.exists(WORKER_HEARTBEAT_KEY)) === 1;
  } catch {
    return false;
  }
}
