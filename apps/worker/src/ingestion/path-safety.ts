import { resolve, sep } from "node:path";

/**
 * Resolves an archive entry's path against the extraction workspace and
 * throws if it would land outside it — the core defense against path
 * traversal (`../../etc/passwd`), absolute-path entries (`/etc/passwd`),
 * and similar archive-entry tricks. Every extracted file goes through this
 * before a single byte is written; never trust an archive entry path.
 *
 * Deliberately re-checked here even though the `tar` package has its own
 * safety measures — belt and suspenders for an untrusted-input boundary.
 */
export class UnsafeArchivePathError extends Error {
  constructor(public readonly entryPath: string) {
    super(`Archive entry path escapes the extraction workspace: ${entryPath}`);
    this.name = "UnsafeArchivePathError";
  }
}

export function resolveSafeEntryPath(workspaceDir: string, entryPath: string): string {
  const resolvedWorkspace = resolve(workspaceDir);
  const resolvedEntry = resolve(resolvedWorkspace, entryPath);

  // The resolved entry must be the workspace dir itself or nested under it
  // (`startsWith` alone would wrongly accept a sibling like
  // "/workspace-evil" against "/workspace" — the trailing separator check
  // rules that out).
  if (resolvedEntry !== resolvedWorkspace && !resolvedEntry.startsWith(resolvedWorkspace + sep)) {
    throw new UnsafeArchivePathError(entryPath);
  }

  return resolvedEntry;
}
