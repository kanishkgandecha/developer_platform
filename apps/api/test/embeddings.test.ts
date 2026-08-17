import { randomBytes, createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma, toVectorLiteral } from "@developer-platform/database";
import { createMockEmbeddingProvider, type EmbeddingProvider } from "@developer-platform/ai";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as QueueService from "../src/queue.js";

// The POST route checks `env.OPENAI_API_KEY` directly (not through the
// mockable provider factory below) — set before importing the app so the
// module-level `env` singleton picks it up. The "not configured" (503) path
// is exercised in its own file (embeddings-not-configured.test.ts) instead,
// since `env` is only ever loaded once per test process.
process.env.OPENAI_API_KEY = "sk-test-fake-key-for-tests";

const mockEnqueueEmbeddingJob = vi.fn();
vi.mock("../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, enqueueEmbeddingJob: mockEnqueueEmbeddingJob };
});

const mockGetEmbeddingProvider = vi.fn<() => EmbeddingProvider | null>();
vi.mock("../src/services/embedding-provider.js", () => ({
  getEmbeddingProvider: () => mockGetEmbeddingProvider(),
}));

const { buildApp } = await import("../src/app.js");
const { encryptToken } = await import("../src/services/crypto.js");

describe("unauthenticated access to embedding endpoints", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  const id = "clsomefakeid00000000000000";
  const cases: [string, string][] = [
    ["POST", `/repositories/${id}/embeddings`],
    ["GET", `/repositories/${id}/embeddings`],
    ["GET", `/embeddings/${id}`],
    ["POST", `/repositories/${id}/search`],
  ];

  for (const [method, url] of cases) {
    it(`${method} ${url} returns 401 without a session`, async () => {
      const response = await app.inject({ method: method as "GET" | "POST", url, payload: { query: "test" } });
      expect(response.statusCode).toBe(401);
    });
  }
});

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("semantic search + embeddings (live database)", () => {
  const app = buildApp();
  const marker = randomBytes(6).toString("hex");

  async function createUserWithSession(githubId: number, username: string) {
    const user = await prisma.user.create({
      data: { githubAccount: { create: { githubId, username, accessTokenEncrypted: encryptToken("fake-token") } } },
    });
    const token = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: { userId: user.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) },
    });
    return { userId: user.id, sessionToken: token };
  }

  let userA: { userId: string; sessionToken: string };
  let userB: { userId: string; sessionToken: string };
  let repoA: { id: string };
  let repoNotAnalyzed: { id: string };
  let analysisRunA: { id: string };
  let fileA: { id: string };

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.userId, userB.userId] } } });
    await app.close();
  });

  afterEach(() => {
    mockEnqueueEmbeddingJob.mockReset();
    mockGetEmbeddingProvider.mockReset();
  });

  it("seeds two users, an analyzed repository, and a repository with no completed analysis", async () => {
    userA = await createUserWithSession(83_000_000 + Number.parseInt(marker.slice(0, 4), 16), `em-a-${marker}`);
    userB = await createUserWithSession(83_100_000 + Number.parseInt(marker.slice(0, 4), 16), `em-b-${marker}`);

    repoA = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 701,
        owner: "user-a",
        name: "repo-embed",
        fullName: "user-a/repo-embed",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-embed",
      },
    });
    repoNotAnalyzed = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 702,
        owner: "user-a",
        name: "repo-no-analysis",
        fullName: "user-a/repo-no-analysis",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-no-analysis",
      },
    });

    const ingestionA = await prisma.ingestion.create({
      data: { repositoryId: repoA.id, commitSha: "sha-embed-api-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    fileA = await prisma.repositoryFile.create({
      data: {
        ingestionId: ingestionA.id,
        path: "src/services/session.ts",
        name: "session.ts",
        extension: ".ts",
        language: "TypeScript",
        category: "SOURCE",
        size: 100,
        isSource: true,
      },
    });
    analysisRunA = await prisma.analysisRun.create({
      data: { ingestionId: ingestionA.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 0, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });

    await prisma.ingestion.create({
      data: { repositoryId: repoNotAnalyzed.id, commitSha: "sha-embed-api-0002", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });

    expect(analysisRunA.id).toBeTruthy();
  });

  describe("POST /repositories/:id/embeddings", () => {
    it("returns 404 for a repository owned by someone else", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
      });
      expect(response.statusCode).toBe(404);
      expect(mockEnqueueEmbeddingJob).not.toHaveBeenCalled();
    });

    it("returns 409 when the repository has no completed analysis yet", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoNotAnalyzed.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(409);
      expect(mockEnqueueEmbeddingJob).not.toHaveBeenCalled();
    });

    it("creates a QUEUED embedding run and enqueues a job, scoped to the repository's user", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({ status: "QUEUED", analysisRunId: analysisRunA.id, repositoryId: repoA.id });
      expect(mockEnqueueEmbeddingJob).toHaveBeenCalledWith({
        embeddingRunId: body.id,
        repositoryId: repoA.id,
        analysisRunId: analysisRunA.id,
      });
    });

    it("returns 409 (not a duplicate row) when an embedding run is already active for this analysis", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(409);
      expect(mockEnqueueEmbeddingJob).not.toHaveBeenCalled();

      const count = await prisma.embeddingRun.count({ where: { analysisRunId: analysisRunA.id } });
      expect(count).toBe(1);
    });

    it("a repository ID that doesn't exist at all also returns 404, not a different error", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/clnonexistentrepoid0000000/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe("GET /repositories/:id/embeddings and GET /embeddings/:id", () => {
    it("lists this repository's embedding runs, ownership-scoped", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/repositories/${repoA.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().embeddings).toHaveLength(1);

      const forbidden = await app.inject({
        method: "GET",
        url: `/repositories/${repoA.id}/embeddings`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
      });
      expect(forbidden.statusCode).toBe(404);
    });

    it("GET /embeddings/:id returns the run for its owner and 404 for anyone else", async () => {
      const run = await prisma.embeddingRun.findUniqueOrThrow({ where: { analysisRunId: analysisRunA.id } });

      const owner = await app.inject({
        method: "GET",
        url: `/embeddings/${run.id}`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(owner.statusCode).toBe(200);
      expect(owner.json()).toMatchObject({ id: run.id, status: "QUEUED" });

      const other = await app.inject({
        method: "GET",
        url: `/embeddings/${run.id}`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
      });
      expect(other.statusCode).toBe(404);
    });

    it("rejects a malformed embedding run id with 422", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/embeddings/not-a-valid-cuid",
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(422);
    });
  });

  describe("POST /repositories/:id/search", () => {
    it("returns status 'not_configured' when no embedding provider is available", async () => {
      mockGetEmbeddingProvider.mockReturnValue(null);
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/search`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
        payload: { query: "session token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "not_configured", results: [] });
    });

    it("returns status 'indexing' while the embedding run is active", async () => {
      mockGetEmbeddingProvider.mockReturnValue(createMockEmbeddingProvider({ dimensions: 1536 }));
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/search`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
        payload: { query: "session token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "indexing", results: [] });
    });

    it("returns status 'not_indexed' for a repository that's never had an embedding run", async () => {
      mockGetEmbeddingProvider.mockReturnValue(createMockEmbeddingProvider({ dimensions: 1536 }));
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoNotAnalyzed.id}/search`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
        payload: { query: "session token" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: "not_indexed", results: [] });
    });

    it("validates the request body — empty query is rejected with 422", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/search`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
        payload: { query: "" },
      });
      expect(response.statusCode).toBe(422);
    });

    it("returns 404 (not leaked existence) for a repository owned by someone else", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/repositories/${repoA.id}/search`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
        payload: { query: "session token" },
      });
      expect(response.statusCode).toBe(404);
    });

    describe("with a completed embedding run and real (mock-embedded) chunks", () => {
      const provider = createMockEmbeddingProvider({ dimensions: 1536 });

      it("marks the embedding run COMPLETED and seeds two chunks with real vectors", async () => {
        const run = await prisma.embeddingRun.update({
          where: { analysisRunId: analysisRunA.id },
          data: { status: "COMPLETED", chunksDiscovered: 2, chunksReused: 0, chunksEmbedded: 2, chunksDeleted: 0, completedAt: new Date() },
        });

        const [sessionVec, unrelatedVec] = await provider.embedDocuments([
          "export function hashSessionToken(token: string): string { return sha256(token); }",
          "export const UNRELATED_CONSTANT = 42;",
        ]);

        await prisma.$executeRaw`
          INSERT INTO "code_chunk" ("id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath", "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName", "language", "charCount", "embedding", "createdAt", "updatedAt")
          VALUES
            (gen_random_uuid()::text, ${repoA.id}, ${fileA.id}, ${analysisRunA.id}, ${run.id}, 'src/services/session.ts', 0, 'export function hashSessionToken(token: string): string { return sha256(token); }', 'hash-session', 1, 3, NULL, 'hashSessionToken', 'TypeScript', 80, ${toVectorLiteral(sessionVec!.vector)}::vector, now(), now()),
            (gen_random_uuid()::text, ${repoA.id}, ${fileA.id}, ${analysisRunA.id}, ${run.id}, 'src/services/session.ts', 1, 'export const UNRELATED_CONSTANT = 42;', 'hash-unrelated', 5, 5, NULL, NULL, 'TypeScript', 40, ${toVectorLiteral(unrelatedVec!.vector)}::vector, now(), now())
        `;

        const count = await prisma.codeChunk.count({ where: { embeddingRunId: run.id } });
        expect(count).toBe(2);
      });

      it("returns status 'ready' with correctly-shaped, self-consistent results scoped to the repository", async () => {
        mockGetEmbeddingProvider.mockReturnValue(provider);

        const response = await app.inject({
          method: "POST",
          url: `/repositories/${repoA.id}/search`,
          cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
          payload: { query: "hashSessionToken", limit: 10 },
        });

        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.status).toBe("ready");
        expect(body.results.length).toBeGreaterThan(0);

        for (const result of body.results) {
          expect(result).toMatchObject({
            chunkId: expect.any(String),
            fileId: fileA.id,
            filePath: "src/services/session.ts",
            language: "TypeScript",
          });
          // finalScore is a deterministic function of the two component scores.
          const expectedFinal =
            result.lexicalScore === null ? result.semanticScore : 0.75 * result.semanticScore + 0.25 * result.lexicalScore;
          expect(result.finalScore).toBeCloseTo(expectedFinal, 6);
        }

        // The exact symbol-name match should outrank the unrelated chunk.
        const symbolNames = body.results.map((r: { symbolName: string | null }) => r.symbolName);
        expect(symbolNames[0]).toBe("hashSessionToken");

        // Results are sorted by finalScore descending.
        const scores = body.results.map((r: { finalScore: number }) => r.finalScore);
        expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
      });

      it("never returns another repository's chunks — a second repository's chunk with a stronger match is still excluded", async () => {
        // Seed a repository owned by userB with a chunk that would win on
        // pure lexical relevance if repository scoping were broken.
        const ingestionB = await prisma.ingestion.create({
          data: { repositoryId: (await prisma.repository.create({
            data: { userId: userB.userId, githubId: 703, owner: "user-b", name: "repo-b-embed", fullName: "user-b/repo-b-embed", defaultBranch: "main", private: false, htmlUrl: "https://github.com/user-b/repo-b-embed" },
          })).id, commitSha: "sha-embed-api-b-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
        });
        const repoB = await prisma.repository.findFirstOrThrow({ where: { githubId: 703, userId: userB.userId } });
        const fileB = await prisma.repositoryFile.create({
          data: { ingestionId: ingestionB.id, path: "src/x.ts", name: "x.ts", extension: ".ts", language: "TypeScript", category: "SOURCE", size: 10, isSource: true },
        });
        const analysisRunB = await prisma.analysisRun.create({
          data: { ingestionId: ingestionB.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 0, importsFound: 0, findingsCount: 0, completedAt: new Date() },
        });
        const embeddingRunB = await prisma.embeddingRun.create({
          data: { repositoryId: repoB.id, analysisRunId: analysisRunB.id, status: "COMPLETED", model: "mock-embedding", dimensions: 1536, chunksDiscovered: 1, chunksReused: 0, chunksEmbedded: 1, chunksDeleted: 0, completedAt: new Date() },
        });
        const [vec] = await provider.embedDocuments(["export function hashSessionToken(token: string) { return token; }"]);
        await prisma.$executeRaw`
          INSERT INTO "code_chunk" ("id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath", "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName", "language", "charCount", "embedding", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${repoB.id}, ${fileB.id}, ${analysisRunB.id}, ${embeddingRunB.id}, 'src/x.ts', 0, 'export function hashSessionToken(token: string) { return token; }', 'hash-b', 1, 1, NULL, 'hashSessionToken', 'TypeScript', 60, ${toVectorLiteral(vec!.vector)}::vector, now(), now())
        `;

        mockGetEmbeddingProvider.mockReturnValue(provider);
        const response = await app.inject({
          method: "POST",
          url: `/repositories/${repoA.id}/search`,
          cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
          payload: { query: "hashSessionToken", limit: 10 },
        });

        const body = response.json();
        for (const result of body.results) {
          expect(result.fileId).not.toBe(fileB.id);
        }
        // repoB (and everything under it) is cleaned up by this describe
        // block's outer `afterAll`, which deletes userB and cascades.
      });
    });
  });
});

describe.skipIf(dbAvailable)("semantic search + embeddings (live database)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
