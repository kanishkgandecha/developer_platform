import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../env.js";
import { logger } from "../logger.js";

/**
 * Root directory all ingestion workspaces live under — resolved once,
 * relative to the worker process's cwd (see INGESTION_WORKSPACE_DIR's doc
 * comment in packages/shared/src/env.ts for why that's cwd-relative and
 * still does the right thing in both Docker and local dev).
 */
const WORKSPACE_ROOT = resolve(process.cwd(), env.INGESTION_WORKSPACE_DIR);

/** Each ingestion gets its own isolated directory, named by its own id — never shared, never reused. */
export function workspacePathFor(ingestionId: string): string {
  return resolve(WORKSPACE_ROOT, ingestionId);
}

export async function createWorkspace(ingestionId: string): Promise<string> {
  const path = workspacePathFor(ingestionId);
  await mkdir(path, { recursive: true });
  return path;
}

/**
 * Best-effort cleanup. A failure here is logged, not thrown — an ingestion
 * that otherwise succeeded (or failed for an unrelated reason) shouldn't be
 * reported as failed just because disk cleanup hit a snag, and the worker
 * itself must never crash over it. Never logs the path to anything
 * user-facing; the API layer never sees workspace paths at all.
 */
export async function cleanupWorkspace(ingestionId: string): Promise<void> {
  const path = workspacePathFor(ingestionId);
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    logger.warn({ ingestionId, err: error }, "failed to clean up ingestion workspace");
  }
}
