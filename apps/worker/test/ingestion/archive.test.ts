import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as tar from "tar";
import { extractArchive, ExtractionLimitError } from "../../src/ingestion/archive.js";

const GENEROUS_LIMITS = {
  maxRepositorySizeBytes: 100 * 1024 * 1024,
  maxFileSizeBytes: 10 * 1024 * 1024,
  maxFiles: 10_000,
};

describe("extractArchive", () => {
  let sourceDir: string;
  let workspaceDir: string;
  let tarPath: string;

  beforeEach(async () => {
    sourceDir = await mkdtemp(join(tmpdir(), "archive-source-"));
    workspaceDir = await mkdtemp(join(tmpdir(), "archive-workspace-"));
    tarPath = join(tmpdir(), `test-archive-${Date.now()}-${Math.random().toString(36).slice(2)}.tar.gz`);
  });

  afterEach(async () => {
    await Promise.all([
      rm(sourceDir, { recursive: true, force: true }),
      rm(workspaceDir, { recursive: true, force: true }),
      rm(tarPath, { force: true }),
    ]);
  });

  /** Mirrors what GitHub actually ships: everything nested one level under a top-level directory, stripped on extraction. */
  async function buildArchive(topLevelDirName = "owner-repo-abc1234"): Promise<void> {
    await tar.create({ gzip: true, file: tarPath, cwd: sourceDir }, ["."]);
    void topLevelDirName; // archive.ts's `strip: 1` handles this regardless of what the real name is
  }

  function openArchiveStream(): Readable {
    return createReadStream(tarPath);
  }

  it("extracts real files into the workspace, preserving structure", async () => {
    await mkdir(join(sourceDir, "src"), { recursive: true });
    await writeFile(join(sourceDir, "package.json"), '{"name":"test"}');
    await writeFile(join(sourceDir, "src", "index.ts"), "export {};");
    await buildArchive();

    const result = await extractArchive(openArchiveStream(), workspaceDir, GENEROUS_LIMITS);

    expect(result.extractedCount).toBe(2);
    const rootEntries = await readdir(workspaceDir);
    expect(rootEntries.sort()).toEqual(["package.json", "src"]);
  });

  it("never extracts a symlink entry, even one pointing inside the workspace", async () => {
    await writeFile(join(sourceDir, "real-file.txt"), "hello");
    await symlink("real-file.txt", join(sourceDir, "sneaky-link.txt"));
    await buildArchive();

    const result = await extractArchive(openArchiveStream(), workspaceDir, GENEROUS_LIMITS);

    const rootEntries = await readdir(workspaceDir);
    expect(rootEntries).toContain("real-file.txt");
    expect(rootEntries).not.toContain("sneaky-link.txt");
    expect(result.extractedCount).toBe(1); // only the real file, not the symlink
  });

  it("skips (but doesn't fail the whole extraction over) a single file over the per-file size cap", async () => {
    await writeFile(join(sourceDir, "small.txt"), "small");
    await writeFile(join(sourceDir, "huge.bin"), Buffer.alloc(2000, 1));
    await buildArchive();

    const result = await extractArchive(openArchiveStream(), workspaceDir, {
      ...GENEROUS_LIMITS,
      maxFileSizeBytes: 1000, // smaller than huge.bin, larger than small.txt
    });

    const rootEntries = await readdir(workspaceDir);
    expect(rootEntries).toContain("small.txt");
    expect(rootEntries).not.toContain("huge.bin");
    expect(result.extractedCount).toBe(1);
  });

  it("fails the whole extraction when the file count exceeds the configured limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(sourceDir, `file-${i}.txt`), "x");
    }
    await buildArchive();

    await expect(
      extractArchive(openArchiveStream(), workspaceDir, { ...GENEROUS_LIMITS, maxFiles: 3 }),
    ).rejects.toThrow(ExtractionLimitError);
  });

  it("fails the whole extraction when the cumulative extracted size exceeds the configured limit", async () => {
    await writeFile(join(sourceDir, "a.bin"), Buffer.alloc(600, 1));
    await writeFile(join(sourceDir, "b.bin"), Buffer.alloc(600, 1));
    await buildArchive();

    await expect(
      extractArchive(openArchiveStream(), workspaceDir, {
        ...GENEROUS_LIMITS,
        maxFileSizeBytes: 1000, // each file individually fits
        maxRepositorySizeBytes: 1000, // but both together don't
      }),
    ).rejects.toThrow(ExtractionLimitError);
  });

  it("rejects a malformed (non-tar) archive instead of hanging or crashing the process", async () => {
    const garbage = Readable.from([Buffer.from("this is not a valid gzip/tar stream at all")]);
    await expect(extractArchive(garbage, workspaceDir, GENEROUS_LIMITS)).rejects.toThrow();
  });
});
