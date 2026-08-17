import { loadEnv } from "@developer-platform/shared";

/**
 * Validated once at process boot. Throws (and the caller in index.ts exits
 * the process) rather than letting a misconfigured deploy limp along with a
 * raw runtime stack trace later.
 */
export const env = loadEnv(process.env);
