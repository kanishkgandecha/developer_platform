import { getRedisConnection } from "./connection.js";
import { logger } from "./logger.js";

const HEARTBEAT_KEY = "worker:heartbeat";
const HEARTBEAT_INTERVAL_MS = 10_000;
// Comfortably longer than the interval so a single slow tick doesn't flap
// the status between "ok" and "error" — apps/api's /health considers the
// worker down if this key is missing or older than this TTL.
const HEARTBEAT_TTL_SECONDS = 30;

let timer: ReturnType<typeof setInterval> | undefined;

async function beat(): Promise<void> {
  try {
    await getRedisConnection().set(HEARTBEAT_KEY, new Date().toISOString(), "EX", HEARTBEAT_TTL_SECONDS);
  } catch (error) {
    logger.warn({ err: error }, "failed to write worker heartbeat");
  }
}

/** Starts writing a periodic liveness heartbeat to Redis — read by apps/api's /health so /status can show real worker state, not a hardcoded value. */
export function startHeartbeat(): void {
  void beat();
  timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  timer.unref(); // never keeps the process alive on its own
}

export function stopHeartbeat(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}
