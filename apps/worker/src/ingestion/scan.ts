import { readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { classifyFile, isIgnoredDirectoryName } from "@developer-platform/code-analysis";
import type { FileCategory } from "@developer-platform/code-analysis";

export interface ScannedFile {
  /** Relative to the repository root, forward-slash-separated regardless of OS. */
  path: string;
  name: string;
  extension: string | null;
  language: string | null;
  category: FileCategory;
  size: number;
  isSource: boolean;
  isIgnored: boolean;
}

/**
 * Walks the already-safely-extracted workspace (see archive.ts — everything
 * on disk here was already validated during extraction) and classifies
 * every file it finds. Whole ignored directories (node_modules, .git, ...)
 * are pruned before descending into them, so their contents are never
 * stat'd, classified, or turned into rows at all.
 */
export async function scanWorkspace(rootDir: string): Promise<ScannedFile[]> {
  const results: ScannedFile[] = [];
  await walk(rootDir, [], results);
  return results;
}

async function walk(absoluteDir: string, relativeSegments: string[], results: ScannedFile[]): Promise<void> {
  const entries = await readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      // Extraction never writes symlinks (see archive.ts), but skip
      // defensively rather than following one if something unexpected
      // slipped through.
      continue;
    }

    if (entry.isDirectory()) {
      if (isIgnoredDirectoryName(entry.name)) {
        continue;
      }
      await walk(join(absoluteDir, entry.name), [...relativeSegments, entry.name], results);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const absolutePath = join(absoluteDir, entry.name);
    const stats = await stat(absolutePath);
    const extension = extname(entry.name) || null;
    const classification = classifyFile(entry.name, extension ?? "");

    results.push({
      path: [...relativeSegments, entry.name].join("/"),
      name: entry.name,
      extension,
      language: classification.language,
      category: classification.category,
      size: stats.size,
      isSource: classification.isSource,
      isIgnored: classification.isIgnored,
    });
  }
}
