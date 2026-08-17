import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, prisma, toVectorLiteral } from "@developer-platform/database";
import { chunkFile } from "@developer-platform/code-analysis";
import { createMockEmbeddingProvider } from "@developer-platform/ai";
import { searchRepository } from "../../src/services/search.js";

/**
 * A small, deterministic, manually-written retrieval evaluation dataset —
 * not LLM-generated, per Phase 5 spec §30. Each query names a real question
 * about *this actual codebase* and the one real source file that answers
 * it; the corpus is a curated set of real files from this repository,
 * chunked with the real chunking engine (no symbols — the line-based
 * fallback path; symbol-aware chunk *boundaries* are already covered by
 * packages/code-analysis/src/chunking/chunk-file.test.ts, this evaluation
 * is about retrieval quality, not chunking) and embedded with the
 * deterministic mock provider (see docs/semantic-search.md's "known
 * limitations" — no real OpenAI credentials were available for this
 * evaluation; recall here is driven primarily by the hybrid layer's
 * lexical scoring, which needs no real semantic embedding to work).
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");

const CORPUS_FILES = [
  "apps/api/src/routes/auth.ts",
  "apps/api/src/services/session.ts",
  "apps/api/src/routes/repositories.ts",
  "apps/worker/src/ingestion/workspace.ts",
  "apps/worker/src/analysis/pipeline.ts",
  "packages/code-analysis/src/analysis/dependency-graph.ts",
  "packages/database/src/vector.ts",
  "apps/worker/src/job-runner.ts",
  "apps/api/src/plugins/auth.ts",
  "apps/worker/src/embedding/embed-files.ts",
  "packages/ai/src/embedding/create-provider-from-env.ts",
  "apps/worker/src/services/github-archive.ts",
  "apps/api/src/services/crypto.ts",
  "apps/api/src/services/search.ts",
  "apps/worker/src/jobs/ingestion-job.ts",
] as const;

interface EvalQuery {
  query: string;
  expectedFile: (typeof CORPUS_FILES)[number];
}

const EVAL_QUERIES: EvalQuery[] = [
  { query: "How is GitHub OAuth state validated?", expectedFile: "apps/api/src/routes/auth.ts" },
  { query: "Where are session tokens hashed?", expectedFile: "apps/api/src/services/session.ts" },
  { query: "How are repository ownership checks implemented?", expectedFile: "apps/api/src/routes/repositories.ts" },
  { query: "Where is the ingestion workspace deleted?", expectedFile: "apps/worker/src/ingestion/workspace.ts" },
  { query: "How does the analysis worker process a repository?", expectedFile: "apps/worker/src/analysis/pipeline.ts" },
  { query: "How are TypeScript imports resolved to a target file?", expectedFile: "packages/code-analysis/src/analysis/dependency-graph.ts" },
  { query: "How is pgvector's vector literal format built?", expectedFile: "packages/database/src/vector.ts" },
  { query: "How are BullMQ jobs and workers created?", expectedFile: "apps/worker/src/job-runner.ts" },
  { query: "Where is request.user resolved from the session cookie?", expectedFile: "apps/api/src/plugins/auth.ts" },
  { query: "How does the embedding pipeline diff and reuse existing chunks?", expectedFile: "apps/worker/src/embedding/embed-files.ts" },
  { query: "Where is the embedding provider constructed from environment configuration?", expectedFile: "packages/ai/src/embedding/create-provider-from-env.ts" },
  { query: "How is a GitHub repository tarball archive downloaded?", expectedFile: "apps/worker/src/services/github-archive.ts" },
  { query: "Where are GitHub access tokens encrypted with AES-256-GCM?", expectedFile: "apps/api/src/services/crypto.ts" },
  { query: "How is the hybrid semantic and lexical search score computed?", expectedFile: "apps/api/src/services/search.ts" },
  { query: "Where does an ingestion job get enqueued and consumed?", expectedFile: "apps/worker/src/jobs/ingestion-job.ts" },
];

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("retrieval evaluation (Recall@5 / Recall@10)", () => {
  const marker = randomBytes(6).toString("hex");
  const provider = createMockEmbeddingProvider({ dimensions: 1536 });
  let userId: string;
  let repositoryId: string;
  let embeddingRunId: string;

  beforeAll(async () => {
    const user = await prisma.user.create({ data: {} });
    userId = user.id;
    const repository = await prisma.repository.create({
      data: {
        userId,
        githubId: 91_000_000 + Number.parseInt(marker.slice(0, 4), 16),
        owner: "eval",
        name: "eval-corpus",
        fullName: "eval/eval-corpus",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/eval/eval-corpus",
      },
    });
    repositoryId = repository.id;
    const ingestion = await prisma.ingestion.create({
      data: { repositoryId, commitSha: "sha-eval-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    const analysisRun = await prisma.analysisRun.create({
      data: { ingestionId: ingestion.id, status: "COMPLETED", filesAnalyzed: CORPUS_FILES.length, symbolsFound: 0, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });
    const embeddingRun = await prisma.embeddingRun.create({
      data: { repositoryId, analysisRunId: analysisRun.id, status: "EMBEDDING", model: provider.model, dimensions: provider.dimensions },
    });
    embeddingRunId = embeddingRun.id;

    // Chunk and embed every corpus file for real, into a real Postgres+pgvector row.
    for (const relativePath of CORPUS_FILES) {
      const content = await readFile(resolve(REPO_ROOT, relativePath), "utf-8");
      const file = await prisma.repositoryFile.create({
        data: {
          ingestionId: ingestion.id,
          path: relativePath,
          name: relativePath.split("/").pop()!,
          extension: ".ts",
          language: "TypeScript",
          category: "SOURCE",
          size: content.length,
          isSource: true,
        },
      });

      const chunks = chunkFile({ filePath: relativePath, language: "TypeScript", content, symbols: [] });
      const texts = chunks.map((c) => c.content);
      const vectors = await provider.embedDocuments(texts);

      for (const [index, chunk] of chunks.entries()) {
        await prisma.$executeRaw`
          INSERT INTO "code_chunk" ("id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath", "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName", "language", "charCount", "embedding", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${repositoryId}, ${file.id}, ${analysisRun.id}, ${embeddingRunId}, ${relativePath}, ${chunk.chunkIndex}, ${chunk.content}, ${chunk.contentHash}, ${chunk.startLine}, ${chunk.endLine}, NULL, NULL, 'TypeScript', ${chunk.charCount}, ${toVectorLiteral(vectors[index]!.vector)}::vector, now(), now())
        `;
      }
    }

    await prisma.embeddingRun.update({ where: { id: embeddingRunId }, data: { status: "COMPLETED", completedAt: new Date() } });
  }, 30_000);

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it(`indexed all ${CORPUS_FILES.length} corpus files into real chunks`, async () => {
    const count = await prisma.codeChunk.count({ where: { repositoryId } });
    expect(count).toBeGreaterThanOrEqual(CORPUS_FILES.length);
  });

  it("reports Recall@5 and Recall@10 across the evaluation dataset", async () => {
    let hitsAt5 = 0;
    let hitsAt10 = 0;
    const misses: string[] = [];

    for (const { query, expectedFile } of EVAL_QUERIES) {
      // Ask for a wide chunk pool, then rank by *file* (best chunk per
      // file) — the corpus here is small enough that several chunks from
      // one file can otherwise crowd out a different file's single best
      // chunk from a raw top-10 *chunk* list. Recall@K is conventionally a
      // file-level (document-level) metric; the search API itself still
      // returns chunks, unchanged — this dedup is specific to how this
      // evaluation scores relevance, not a change to retrieval behavior.
      const results = await searchRepository({ repositoryId, query, limit: 50, provider });
      const seenFiles = new Set<string>();
      const filesInOrder: string[] = [];
      for (const result of results) {
        if (!seenFiles.has(result.filePath)) {
          seenFiles.add(result.filePath);
          filesInOrder.push(result.filePath);
        }
      }

      if (filesInOrder.slice(0, 5).includes(expectedFile)) hitsAt5 += 1;
      if (filesInOrder.slice(0, 10).includes(expectedFile)) hitsAt10 += 1;
      else misses.push(`"${query}" — expected ${expectedFile}, got [${filesInOrder.slice(0, 3).join(", ")}]`);
    }

    const recallAt5 = hitsAt5 / EVAL_QUERIES.length;
    const recallAt10 = hitsAt10 / EVAL_QUERIES.length;

    console.log(
      `\nRetrieval evaluation: Recall@5 = ${(recallAt5 * 100).toFixed(0)}% (${hitsAt5}/${EVAL_QUERIES.length}), ` +
        `Recall@10 = ${(recallAt10 * 100).toFixed(0)}% (${hitsAt10}/${EVAL_QUERIES.length})` +
        (misses.length > 0 ? `\nMisses:\n  ${misses.join("\n  ")}` : ""),
    );

    // A floor, not a target to chase — proves retrieval is genuinely
    // working (per spec §30, "prove retrieval is working," not "hit an
    // arbitrary benchmark number"), using only lexical-matchable queries
    // against a mock (semantically meaningless) embedding provider.
    expect(recallAt10).toBeGreaterThanOrEqual(0.6);
    expect(recallAt5).toBeGreaterThanOrEqual(0.4);
  });
});

describe.skipIf(dbAvailable)("retrieval evaluation (Recall@5 / Recall@10)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
