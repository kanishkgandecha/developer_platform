import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { createMockEmbeddingProvider, type EmbeddingProvider } from "@developer-platform/ai";
import type { ChunkableSymbol } from "@developer-platform/code-analysis";
import { embedFilesForRun, type EmbeddingFileInput } from "../../src/embedding/embed-files.js";

const dbAvailable = await checkDatabaseConnection();

/** Wraps a mock provider so tests can assert exactly how many times (and with what) it was actually called — the sharpest way to prove "0 new embeddings" isn't just an accounting artifact. */
function spiedMockProvider(): { provider: EmbeddingProvider; embedDocuments: ReturnType<typeof vi.fn> } {
  // Must match the schema's fixed `vector(1536)` column width (text-embedding-3-small's
  // real dimension) — the mock provider's vectors carry no real semantic
  // meaning, but they still have to satisfy pgvector's dimension check.
  const real = createMockEmbeddingProvider({ dimensions: 1536 });
  const embedDocuments = vi.fn(real.embedDocuments);
  return { provider: { model: real.model, dimensions: real.dimensions, embedDocuments }, embedDocuments };
}

describe.runIf(dbAvailable)("embedFilesForRun (live database)", () => {
  const marker = randomBytes(6).toString("hex");
  let userId: string;
  let repositoryId: string;
  let ingestionId: string;
  let analysisRunId: string;
  let embeddingRunId: string;
  const fileIds: Record<string, string> = {};

  const emptySymbols = new Map<string, ChunkableSymbol[]>();

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("seeds a repository, ingestion, analysis run, embedding run, and five source files", async () => {
    const user = await prisma.user.create({ data: {} });
    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        userId,
        githubId: 9_100_000 + Number.parseInt(marker.slice(0, 4), 16),
        owner: "user-e",
        name: "repo-e",
        fullName: "user-e/repo-e",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-e/repo-e",
      },
    });
    repositoryId = repository.id;

    const ingestion = await prisma.ingestion.create({
      data: { repositoryId, commitSha: "sha-embed-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    ingestionId = ingestion.id;

    for (const name of ["a", "b", "c", "d", "e"]) {
      const file = await prisma.repositoryFile.create({
        data: {
          ingestionId,
          path: `src/${name}.ts`,
          name: `${name}.ts`,
          extension: ".ts",
          language: "TypeScript",
          category: "SOURCE",
          size: 100,
          isSource: true,
        },
      });
      fileIds[name] = file.id;
    }

    const analysisRun = await prisma.analysisRun.create({
      data: { ingestionId, status: "COMPLETED", filesAnalyzed: 5, symbolsFound: 0, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });
    analysisRunId = analysisRun.id;

    const embeddingRun = await prisma.embeddingRun.create({
      data: { repositoryId, analysisRunId, status: "EMBEDDING", model: "mock-embedding", dimensions: 1536 },
    });
    embeddingRunId = embeddingRun.id;

    expect(Object.keys(fileIds)).toHaveLength(5);
  });

  function filesFor(names: string[], contentOverrides: Record<string, string> = {}): EmbeddingFileInput[] {
    return names.map((name) => ({
      fileId: fileIds[name]!,
      path: `src/${name}.ts`,
      language: "TypeScript",
      content: contentOverrides[name] ?? `export function ${name}() {\n  return "${name}";\n}\n`,
    }));
  }

  it("initial run: every file's chunk is new — chunksDiscovered/chunksEmbedded both 5, nothing reused or deleted", async () => {
    const { provider, embedDocuments } = spiedMockProvider();

    const stats = await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files: filesFor(["a", "b", "c", "d", "e"]),
      symbolsByFileId: emptySymbols,
      provider,
      batchSize: 10,
    });

    expect(stats).toEqual({ chunksDiscovered: 5, chunksReused: 0, chunksEmbedded: 5, chunksDeleted: 0 });
    expect(embedDocuments).toHaveBeenCalledTimes(1); // one batch, five texts
    expect(embedDocuments.mock.calls[0]![0]).toHaveLength(5);

    const rows = await prisma.codeChunk.count({ where: { embeddingRunId } });
    expect(rows).toBe(5);
  });

  it("unchanged run: identical content for every file — 0 new embeddings, no provider calls at all", async () => {
    const { provider, embedDocuments } = spiedMockProvider();

    const stats = await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files: filesFor(["a", "b", "c", "d", "e"]),
      symbolsByFileId: emptySymbols,
      provider,
      batchSize: 10,
    });

    expect(stats).toEqual({ chunksDiscovered: 5, chunksReused: 5, chunksEmbedded: 0, chunksDeleted: 0 });
    expect(embedDocuments).not.toHaveBeenCalled();

    const rows = await prisma.codeChunk.count({ where: { embeddingRunId } });
    expect(rows).toBe(5);
  });

  it("one file changed: exactly one new embedding, the other four reused", async () => {
    const { provider, embedDocuments } = spiedMockProvider();

    const stats = await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files: filesFor(["a", "b", "c", "d", "e"], { c: 'export function c() {\n  return "CHANGED";\n}\n' }),
      symbolsByFileId: emptySymbols,
      provider,
      batchSize: 10,
    });

    expect(stats).toEqual({ chunksDiscovered: 5, chunksReused: 4, chunksEmbedded: 1, chunksDeleted: 0 });
    expect(embedDocuments).toHaveBeenCalledTimes(1);
    expect(embedDocuments.mock.calls[0]![0]).toEqual([expect.stringContaining("CHANGED")]);

    const changedChunk = await prisma.codeChunk.findFirst({ where: { embeddingRunId, fileId: fileIds.c } });
    expect(changedChunk?.content).toContain("CHANGED");
  });

  it("a file disappearing from the run's file list: its chunks are deleted, not just left stale", async () => {
    const { provider } = spiedMockProvider();

    const stats = await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files: filesFor(["a", "b", "d", "e"], { c: 'export function c() {\n  return "CHANGED";\n}\n' }), // "c" omitted entirely
      symbolsByFileId: emptySymbols,
      provider,
      batchSize: 10,
    });

    expect(stats).toEqual({ chunksDiscovered: 4, chunksReused: 4, chunksEmbedded: 0, chunksDeleted: 1 });

    const remaining = await prisma.codeChunk.count({ where: { embeddingRunId } });
    expect(remaining).toBe(4);
    const stillThere = await prisma.codeChunk.findFirst({ where: { embeddingRunId, fileId: fileIds.c } });
    expect(stillThere).toBeNull();
  });

  it("reports the diff before any embedding call, and progress incrementally as batches complete", async () => {
    const { provider } = spiedMockProvider();
    const diffs: unknown[] = [];
    const batches: number[] = [];

    await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files: filesFor(["a", "b"], { a: "export function a() { return 'v2'; }\n", b: "export function b() { return 'v2'; }\n" }),
      symbolsByFileId: emptySymbols,
      provider,
      batchSize: 1, // force two separate batches so progress is observable
      onDiffComputed: async (diff) => {
        diffs.push(diff);
      },
      onBatchEmbedded: async (count) => {
        batches.push(count);
      },
    });

    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ chunksToEmbed: 2 });
    expect(batches).toEqual([1, 1]); // batchSize: 1 — two individual batches, not one combined call
  });
});

describe.skipIf(dbAvailable)("embedFilesForRun (live database)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
