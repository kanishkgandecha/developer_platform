/**
 * Directory names pruned entirely wherever they appear in the tree — their
 * contents are never walked, never classified, and never become a
 * RepositoryFile row. This is a performance/volume control (node_modules
 * alone can be hundreds of thousands of files) as much as a relevance one.
 *
 * Centralized here, not duplicated across the worker — see
 * docs/repository-ingestion.md.
 */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".cache",
  "venv",
  ".venv",
  "__pycache__",
  "target",
  "vendor",
]);

export function isIgnoredDirectoryName(name: string): boolean {
  return IGNORED_DIRECTORY_NAMES.has(name);
}
