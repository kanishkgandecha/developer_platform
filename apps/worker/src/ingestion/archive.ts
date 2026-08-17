import type { Readable } from "node:stream";
import * as tar from "tar";
import { resolveSafeEntryPath, UnsafeArchivePathError } from "./path-safety.js";

export interface ExtractionLimits {
  maxRepositorySizeBytes: number;
  maxFileSizeBytes: number;
  maxFiles: number;
}

export class ExtractionLimitError extends Error {
  constructor(public readonly reason: "repository_too_large" | "too_many_files") {
    super(
      reason === "repository_too_large"
        ? "Repository exceeds the configured maximum extracted size"
        : "Repository exceeds the configured maximum file count",
    );
    this.name = "ExtractionLimitError";
  }
}

export interface ExtractionResult {
  /** Files actually written to disk — skipped/oversized/unsafe entries aren't counted here. */
  extractedCount: number;
}

/**
 * Streams a GitHub tarball straight into `tar`'s extractor — never buffers
 * the whole archive into memory. GitHub tarballs always wrap their contents
 * in a single top-level `{owner}-{repo}-{sha}/` directory; `strip: 1` drops
 * it so the repository's own root lands directly in `workspaceDir`.
 *
 * This is Phase 3's untrusted-input boundary — every entry is treated as
 * hostile:
 *   - path traversal / absolute paths: re-validated ourselves via
 *     resolveSafeEntryPath, independent of `tar`'s own protections
 *   - symlinks / hard links: never extracted (they could point outside the
 *     workspace and get silently followed later during scanning)
 *   - per-file size cap: an oversized individual file is skipped (not
 *     extracted, not truncated) rather than filling the disk — its
 *     existence still gets recorded during scanning, just not its content
 *   - cumulative size / file count caps: once exceeded, remaining entries
 *     are skipped and the whole ingestion is failed afterward (see
 *     ExtractionLimitError) — a bound repository never gets partially
 *     trusted as "done"
 *
 * Repository code is never executed here or anywhere else in this
 * pipeline — this function only ever writes files to disk.
 */
export async function extractArchive(
  archiveStream: Readable,
  workspaceDir: string,
  limits: ExtractionLimits,
): Promise<ExtractionResult> {
  let cumulativeBytes = 0;
  let acceptedCount = 0;
  let sawUnsafePath = false;
  let limitReason: ExtractionLimitError["reason"] | null = null;

  const extractor = tar.extract({
    cwd: workspaceDir,
    strip: 1,
    // Never let an entry outside the top-level directory through even if
    // `strip` produces something odd for a malformed archive.
    preservePaths: false,
    filter: (entryPath, entry) => {
      if (limitReason) return false; // already over a repo-level cap — stop extracting

      // `tar`'s filter signature types `entry` generically as `Stats |
      // ReadEntry` across its create/extract/list APIs — only ReadEntry
      // (what extraction actually passes) has `.type`.
      if ("type" in entry && (entry.type === "SymbolicLink" || entry.type === "Link")) {
        return false;
      }

      try {
        resolveSafeEntryPath(workspaceDir, entryPath);
      } catch (error) {
        if (error instanceof UnsafeArchivePathError) {
          sawUnsafePath = true;
          return false;
        }
        throw error;
      }

      // Directory entries are just structure (no content, negligible size)
      // — let them through so nested files have somewhere to land, but
      // don't count them against the file-count/size caps, which are about
      // actual file content.
      if ("type" in entry && entry.type === "Directory") {
        return true;
      }

      const entrySize = typeof entry.size === "number" ? entry.size : 0;

      if (entrySize > limits.maxFileSizeBytes) {
        // Skip this one file (disk-space protection) but don't fail the
        // whole ingestion over a single oversized asset.
        return false;
      }

      if (acceptedCount + 1 > limits.maxFiles) {
        limitReason = "too_many_files";
        return false;
      }

      if (cumulativeBytes + entrySize > limits.maxRepositorySizeBytes) {
        limitReason = "repository_too_large";
        return false;
      }

      cumulativeBytes += entrySize;
      acceptedCount += 1;
      return true;
    },
  });

  await new Promise<void>((resolvePromise, reject) => {
    extractor.on("error", reject);
    archiveStream.on("error", reject);
    extractor.on("close", () => resolvePromise());
    archiveStream.pipe(extractor);
  });

  if (sawUnsafePath) {
    throw new UnsafeArchivePathError("one or more archive entries");
  }
  if (limitReason) {
    throw new ExtractionLimitError(limitReason);
  }

  return { extractedCount: acceptedCount };
}
