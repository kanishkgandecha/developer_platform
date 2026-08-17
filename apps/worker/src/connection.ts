import { Redis, type RedisOptions } from "ioredis";
import { env } from "./env.js";

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it's given
 * (it manages its own retry/backoff semantics for blocking commands) —
 * sharing one misconfigured connection across queues is a common footgun,
 * so this is centralized here rather than repeated per queue/worker file.
 */
const connectionOptions: RedisOptions = {
  maxRetriesPerRequest: null,
};

let sharedConnection: Redis | undefined;

/**
 * A single shared ioredis connection reused by every queue/worker in this
 * process, per BullMQ's recommended pattern.
 */
export function getRedisConnection(): Redis {
  if (!sharedConnection) {
    sharedConnection = new Redis(env.REDIS_URL, connectionOptions);
    // See apps/api/src/redis.ts for why this listener exists: without it,
    // every failed connection attempt logs an unstructured "Unhandled error
    // event" on top of whatever surfaces the failure to the caller.
    sharedConnection.on("error", (error) => {
      if (process.env.NODE_ENV !== "test") {
        console.error("[redis] connection error:", error.message);
      }
    });
  }
  return sharedConnection;
}

export async function checkRedisConnection(): Promise<boolean> {
  try {
    const result = await getRedisConnection().ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

export async function closeRedisConnection(): Promise<void> {
  await sharedConnection?.quit();
  sharedConnection = undefined;
}
