import { randomBytes, createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as QueueService from "../src/queue.js";

const mockEnqueueAnalysisJob = vi.fn();

vi.mock("../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, enqueueAnalysisJob: mockEnqueueAnalysisJob };
});

const { buildApp } = await import("../src/app.js");
const { encryptToken } = await import("../src/services/crypto.js");

describe("unauthenticated access to analysis endpoints", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  const id = "clsomefakeid00000000000000";
  const cases: [string, string][] = [
    ["POST", `/repositories/${id}/analyses`],
    ["GET", `/repositories/${id}/analyses`],
    ["GET", `/analyses/${id}`],
    ["GET", `/analyses/${id}/findings`],
    ["GET", `/analyses/${id}/files`],
    ["GET", `/analyses/${id}/files/${id}`],
  ];

  for (const [method, url] of cases) {
    it(`${method} ${url} returns 401 without a session`, async () => {
      const response = await app.inject({ method: method as "GET" | "POST", url });
      expect(response.statusCode).toBe(401);
    });
  }
});

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("code analysis (live database)", () => {
  const app = buildApp();
  const marker = randomBytes(6).toString("hex");

  async function createUserWithSession(githubId: number, username: string) {
    const user = await prisma.user.create({
      data: {
        githubAccount: {
          create: { githubId, username, accessTokenEncrypted: encryptToken("fake-token-for-tests") },
        },
      },
    });
    const token = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return { userId: user.id, sessionToken: token };
  }

  let userA: { userId: string; sessionToken: string };
  let userB: { userId: string; sessionToken: string };
  let repoA: { id: string };
  let repoNoIngestion: { id: string };
  let ingestionA: { id: string };
  let fileA: { id: string };

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.userId, userB.userId] } } });
    await app.close();
  });

  afterEach(() => {
    mockEnqueueAnalysisJob.mockReset();
  });

  it("sets up two users, a repository with a completed ingestion (and one file), and a repository with none", async () => {
    userA = await createUserWithSession(82_000_000 + Number.parseInt(marker.slice(0, 4), 16), `an-a-${marker}`);
    userB = await createUserWithSession(82_100_000 + Number.parseInt(marker.slice(0, 4), 16), `an-b-${marker}`);

    repoA = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 601,
        owner: "user-a",
        name: "repo-a",
        fullName: "user-a/repo-a",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-a",
      },
    });

    repoNoIngestion = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 602,
        owner: "user-a",
        name: "repo-b",
        fullName: "user-a/repo-b",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-b",
      },
    });

    ingestionA = await prisma.ingestion.create({
      data: {
        repositoryId: repoA.id,
        commitSha: "sha-analysis-0001",
        status: "COMPLETED",
        progress: 100,
        fileCount: 1,
        sourceFileCount: 1,
        completedAt: new Date(),
      },
    });

    fileA = await prisma.repositoryFile.create({
      data: {
        ingestionId: ingestionA.id,
        path: "src/index.ts",
        name: "index.ts",
        extension: ".ts",
        language: "TypeScript",
        category: "SOURCE",
        size: 100,
        isSource: true,
      },
    });

    expect(repoA.id).toBeTruthy();
    expect(fileA.id).toBeTruthy();
  });

  it("POST /repositories/:id/analyses returns 404 for a repository owned by someone else", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);
    expect(mockEnqueueAnalysisJob).not.toHaveBeenCalled();
  });

  it("POST /repositories/:id/analyses returns 409 when there is no completed ingestion yet", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoNoIngestion.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(409);
    expect(mockEnqueueAnalysisJob).not.toHaveBeenCalled();
  });

  it("creates a new QUEUED analysis run and enqueues a job", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: "QUEUED", ingestionId: ingestionA.id });
    expect(mockEnqueueAnalysisJob).toHaveBeenCalledWith({ analysisRunId: body.id, ingestionId: ingestionA.id });
  });

  it("returns 409 (not a duplicate row) when an analysis for this ingestion is already active", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(409);
    expect(mockEnqueueAnalysisJob).not.toHaveBeenCalled();

    const count = await prisma.analysisRun.count({ where: { ingestionId: ingestionA.id } });
    expect(count).toBe(1);
  });

  it("re-runs (201, new job, same row) a COMPLETED analysis run — unlike Ingestion, a completed run is not idempotently reused", async () => {
    const before = await prisma.analysisRun.update({
      where: { ingestionId: ingestionA.id },
      data: { status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 2, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });

    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(before.id); // same row reused, not a new one
    expect(body.status).toBe("QUEUED");
    expect(mockEnqueueAnalysisJob).toHaveBeenCalledWith({ analysisRunId: before.id, ingestionId: ingestionA.id });

    const count = await prisma.analysisRun.count({ where: { ingestionId: ingestionA.id } });
    expect(count).toBe(1);
  });

  it("allows retrying a FAILED analysis by reusing the row and clears stale child rows", async () => {
    const before = await prisma.analysisRun.findUniqueOrThrow({ where: { ingestionId: ingestionA.id } });
    await prisma.analysisRun.update({ where: { id: before.id }, data: { status: "FAILED", error: "boom" } });
    await prisma.finding.create({
      data: { analysisRunId: before.id, ruleId: "TODO_COMMENT", severity: "INFO", message: "stale finding" },
    });

    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/analyses`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(before.id);
    expect(body.status).toBe("QUEUED");
    expect(body.error).toBeNull();
    expect(mockEnqueueAnalysisJob).toHaveBeenCalledWith({ analysisRunId: before.id, ingestionId: ingestionA.id });

    const staleFindings = await prisma.finding.count({ where: { analysisRunId: before.id } });
    expect(staleFindings).toBe(0);

    const count = await prisma.analysisRun.count({ where: { ingestionId: ingestionA.id } });
    expect(count).toBe(1); // same row reused, not a new one
  });

  describe("reading a completed analysis with symbols, imports, metrics, and findings", () => {
    let analysisRunId: string;

    it("seeds a completed analysis run with real child rows", async () => {
      const run = await prisma.analysisRun.findUniqueOrThrow({ where: { ingestionId: ingestionA.id } });
      analysisRunId = run.id;

      await prisma.analysisRun.update({
        where: { id: analysisRunId },
        data: { status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 1, importsFound: 1, findingsCount: 2, completedAt: new Date() },
      });

      const classSymbol = await prisma.codeSymbol.create({
        data: {
          analysisRunId,
          fileId: fileA.id,
          name: "Widget",
          kind: "CLASS",
          startLine: 1,
          endLine: 10,
          exported: true,
          complexity: null,
          parameterCount: null,
        },
      });
      await prisma.codeSymbol.create({
        data: {
          analysisRunId,
          fileId: fileA.id,
          name: "render",
          kind: "METHOD",
          startLine: 2,
          endLine: 4,
          exported: false,
          parentId: classSymbol.id,
          complexity: 3,
          parameterCount: 0,
        },
      });
      await prisma.codeImport.create({
        data: { analysisRunId, fileId: fileA.id, source: "node:fs", kind: "IMPORT", line: 1 },
      });
      await prisma.codeMetric.create({
        data: {
          analysisRunId,
          fileId: fileA.id,
          lineCount: 20,
          codeLineCount: 15,
          commentLineCount: 3,
          blankLineCount: 2,
          functionCount: 1,
          classCount: 1,
          importCount: 1,
          exportCount: 1,
          complexity: 3,
        },
      });
      await prisma.finding.createMany({
        data: [
          { analysisRunId, fileId: fileA.id, ruleId: "TODO_COMMENT", severity: "INFO", message: "todo", line: 5 },
          { analysisRunId, fileId: fileA.id, ruleId: "COMPLEXITY_HIGH", severity: "MEDIUM", message: "too complex", line: 2 },
        ],
      });

      expect(classSymbol.id).toBeTruthy();
    });

    it("GET /analyses/:id returns the run with a real severity breakdown", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("COMPLETED");
      expect(body.severityCounts).toMatchObject({ INFO: 1, MEDIUM: 1, HIGH: 0, CRITICAL: 0, LOW: 0 });
    });

    it("GET /analyses/:id returns 404 (not the row) for another user", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
      });
      expect(response.statusCode).toBe(404);
    });

    it("GET /analyses/:id/findings returns paginated, filterable findings with file paths", async () => {
      const all = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}/findings`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(all.statusCode).toBe(200);
      const allBody = all.json();
      expect(allBody.total).toBe(2);
      expect(allBody.findings[0].filePath).toBe("src/index.ts");

      const filtered = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}/findings?severity=MEDIUM`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      const filteredBody = filtered.json();
      expect(filteredBody.total).toBe(1);
      expect(filteredBody.findings[0].ruleId).toBe("COMPLEXITY_HIGH");

      const paged = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}/findings?pageSize=1&page=2`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(paged.json().findings).toHaveLength(1);
    });

    it("GET /analyses/:id/files returns per-file metrics with symbol/import/finding counts", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}/files`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      const { files } = response.json();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ symbolCount: 2, importCount: 1, findingCount: 2 });
      expect(files[0].metrics).toMatchObject({ filePath: "src/index.ts", lineCount: 20 });
    });

    it("GET /analyses/:id/files/:fileId returns the file's symbols (with parent names) and imports", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/analyses/${analysisRunId}/files/${fileA.id}`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.symbols).toHaveLength(2);
      const method = body.symbols.find((s: { name: string }) => s.name === "render");
      expect(method.parentName).toBe("Widget");
      expect(body.imports).toEqual([expect.objectContaining({ source: "node:fs" })]);
    });

    it("GET /repositories/:id/analyses lists this repository's analysis runs, ownership-scoped", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/repositories/${repoA.id}/analyses`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().analyses).toHaveLength(1);

      const forbidden = await app.inject({
        method: "GET",
        url: `/repositories/${repoA.id}/analyses`,
        cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
      });
      expect(forbidden.statusCode).toBe(404);
    });

    it("GET /analyses/:id rejects a malformed id with 422", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/analyses/not-a-valid-cuid",
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(422);
    });

    it("GET /ingestions/:id embeds the ingestion's latest analysis", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/ingestions/${ingestionA.id}`,
        cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().latestAnalysis).toMatchObject({ id: analysisRunId, status: "COMPLETED" });
    });
  });
});
