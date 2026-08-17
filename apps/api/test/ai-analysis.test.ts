import { randomBytes, createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as QueueService from "../src/queue.js";

// The POST route checks `env.OPENAI_API_KEY` directly — set before
// importing the app so the module-level `env` singleton picks it up. The
// "not configured" (503) path is exercised in its own file
// (ai-analysis-not-configured.test.ts), since `env` is only ever loaded
// once per test process — same pattern as embeddings.test.ts.
process.env.OPENAI_API_KEY = "sk-test-fake-key-for-tests";

const mockEnqueueAIAnalysisJob = vi.fn();
vi.mock("../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, enqueueAIAnalysisJob: mockEnqueueAIAnalysisJob };
});

const { buildApp } = await import("../src/app.js");
const { encryptToken } = await import("../src/services/crypto.js");

describe("unauthenticated access to AI analysis endpoints", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  const id = "clsomefakeid00000000000000";
  const cases: [string, string][] = [
    ["POST", `/repositories/${id}/ai-analysis`],
    ["GET", `/repositories/${id}/ai-analysis`],
    ["GET", `/ai-analysis/${id}`],
    ["GET", `/ai-analysis/${id}/agents`],
    ["GET", `/ai-analysis/${id}/findings`],
    ["GET", `/ai-analysis/${id}/findings/${id}`],
  ];

  for (const [method, url] of cases) {
    it(`${method} ${url} returns 401 without a session`, async () => {
      const response = await app.inject({ method: method as "GET" | "POST", url });
      expect(response.statusCode).toBe(401);
    });
  }
});

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("AI analysis (live database)", () => {
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
  let repoReady: { id: string };
  let repoNoAnalysis: { id: string };
  let repoNoEmbedding: { id: string };
  let analysisRunReadyId: string;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.userId, userB.userId] } } });
    await app.close();
  });

  afterEach(() => {
    mockEnqueueAIAnalysisJob.mockReset();
  });

  it("seeds two users and three repositories in different states of readiness", async () => {
    userA = await createUserWithSession(87_000_000 + Number.parseInt(marker.slice(0, 4), 16), `ai-a-${marker}`);
    userB = await createUserWithSession(87_100_000 + Number.parseInt(marker.slice(0, 4), 16), `ai-b-${marker}`);

    repoReady = await prisma.repository.create({
      data: { userId: userA.userId, githubId: 801, owner: "user-a", name: "repo-ai-ready", fullName: "user-a/repo-ai-ready", defaultBranch: "main", private: false, htmlUrl: "https://github.com/user-a/repo-ai-ready" },
    });
    repoNoAnalysis = await prisma.repository.create({
      data: { userId: userA.userId, githubId: 802, owner: "user-a", name: "repo-ai-no-analysis", fullName: "user-a/repo-ai-no-analysis", defaultBranch: "main", private: false, htmlUrl: "https://github.com/user-a/repo-ai-no-analysis" },
    });
    repoNoEmbedding = await prisma.repository.create({
      data: { userId: userA.userId, githubId: 803, owner: "user-a", name: "repo-ai-no-embedding", fullName: "user-a/repo-ai-no-embedding", defaultBranch: "main", private: false, htmlUrl: "https://github.com/user-a/repo-ai-no-embedding" },
    });

    const ingestionReady = await prisma.ingestion.create({
      data: { repositoryId: repoReady.id, commitSha: "sha-ai-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    const analysisRunReady = await prisma.analysisRun.create({
      data: { ingestionId: ingestionReady.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 1, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });
    analysisRunReadyId = analysisRunReady.id;
    await prisma.embeddingRun.create({
      data: { repositoryId: repoReady.id, analysisRunId: analysisRunReady.id, status: "COMPLETED", model: "mock-embedding", dimensions: 1536, completedAt: new Date() },
    });

    await prisma.ingestion.create({
      data: { repositoryId: repoNoAnalysis.id, commitSha: "sha-ai-0002", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });

    const ingestionNoEmbedding = await prisma.ingestion.create({
      data: { repositoryId: repoNoEmbedding.id, commitSha: "sha-ai-0003", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    await prisma.analysisRun.create({
      data: { ingestionId: ingestionNoEmbedding.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 1, importsFound: 0, findingsCount: 0, completedAt: new Date() },
    });

    expect(analysisRunReadyId).toBeTruthy();
  });

  describe("POST /repositories/:id/ai-analysis", () => {
    it("returns 404 for a repository owned by someone else", async () => {
      const response = await app.inject({ method: "POST", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken } });
      expect(response.statusCode).toBe(404);
      expect(mockEnqueueAIAnalysisJob).not.toHaveBeenCalled();
    });

    it("returns 409 when there is no completed code analysis yet", async () => {
      const response = await app.inject({ method: "POST", url: `/repositories/${repoNoAnalysis.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(409);
      expect(mockEnqueueAIAnalysisJob).not.toHaveBeenCalled();
    });

    it("returns 409 when the repository is not yet semantically indexed", async () => {
      const response = await app.inject({ method: "POST", url: `/repositories/${repoNoEmbedding.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(409);
      expect(mockEnqueueAIAnalysisJob).not.toHaveBeenCalled();
    });

    it("creates a QUEUED AI analysis run and enqueues a job", async () => {
      const response = await app.inject({ method: "POST", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({ status: "QUEUED", analysisRunId: analysisRunReadyId, repositoryId: repoReady.id, provider: "openai", agents: [] });
      expect(mockEnqueueAIAnalysisJob).toHaveBeenCalledWith({ aiAnalysisRunId: body.id, repositoryId: repoReady.id, analysisRunId: analysisRunReadyId });
    });

    it("returns 409 (not a duplicate row) when an AI analysis run is already active", async () => {
      const response = await app.inject({ method: "POST", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(409);
      expect(mockEnqueueAIAnalysisJob).not.toHaveBeenCalled();
      const count = await prisma.aIAnalysisRun.count({ where: { analysisRunId: analysisRunReadyId } });
      expect(count).toBe(1);
    });

    it("re-runs a COMPLETED run by reusing the same row and clearing stale agent/finding rows", async () => {
      const before = await prisma.aIAnalysisRun.update({
        where: { analysisRunId: analysisRunReadyId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      const agentRun = await prisma.agentRun.create({
        data: { aiAnalysisRunId: before.id, agent: "SECURITY", status: "COMPLETED", summary: "stale summary" },
      });
      await prisma.aIFinding.create({
        data: {
          agentRunId: agentRun.id,
          aiAnalysisRunId: before.id,
          category: "stale",
          title: "stale finding",
          summary: "stale",
          severity: "LOW",
          confidence: 0.5,
          evidence: "stale",
          recommendation: "stale",
          citations: [{ filePath: "src/x.ts", startLine: 1, endLine: 1, symbolName: null }],
        },
      });

      const response = await app.inject({ method: "POST", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.id).toBe(before.id);
      expect(body.status).toBe("QUEUED");

      const staleAgentRuns = await prisma.agentRun.count({ where: { aiAnalysisRunId: before.id } });
      expect(staleAgentRuns).toBe(0);
      const staleFindings = await prisma.aIFinding.count({ where: { aiAnalysisRunId: before.id } });
      expect(staleFindings).toBe(0);

      const count = await prisma.aIAnalysisRun.count({ where: { analysisRunId: analysisRunReadyId } });
      expect(count).toBe(1); // same row reused, not a new one
    });
  });

  describe("GET endpoints", () => {
    let aiAnalysisRunId: string;
    let securityFindingId: string;

    it("seeds a completed AI analysis run with agents and findings", async () => {
      const run = await prisma.aIAnalysisRun.update({
        where: { analysisRunId: analysisRunReadyId },
        data: { status: "COMPLETED", startedAt: new Date(), completedAt: new Date() },
      });
      aiAnalysisRunId = run.id;

      const architectureAgent = await prisma.agentRun.create({
        data: { aiAnalysisRunId, agent: "ARCHITECTURE", status: "COMPLETED", summary: "Modular architecture." },
      });
      const securityAgent = await prisma.agentRun.create({
        data: { aiAnalysisRunId, agent: "SECURITY", status: "COMPLETED", summary: "One risk found." },
      });

      await prisma.aIFinding.create({
        data: { agentRunId: architectureAgent.id, aiAnalysisRunId, category: "coupling", title: "Tight coupling", summary: "s", severity: "MEDIUM", confidence: 0.6, evidence: "e", recommendation: "r", citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 2, symbolName: null }] },
      });
      const securityFinding = await prisma.aIFinding.create({
        data: { agentRunId: securityAgent.id, aiAnalysisRunId, category: "secrets", title: "Hardcoded secret", summary: "s", severity: "HIGH", confidence: 0.9, evidence: "e", recommendation: "r", citations: [{ filePath: "src/b.ts", startLine: 3, endLine: 4, symbolName: null }] },
      });
      securityFindingId = securityFinding.id;

      expect(aiAnalysisRunId).toBeTruthy();
    });

    it("GET /ai-analysis/:id returns the run with agents and a real severity breakdown", async () => {
      const response = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe("COMPLETED");
      expect(body.severityCounts).toMatchObject({ HIGH: 1, MEDIUM: 1, CRITICAL: 0, LOW: 0, INFO: 0 });
      expect(body.agents.length).toBeGreaterThanOrEqual(2);
    });

    it("GET /ai-analysis/:id returns 404 for another user", async () => {
      const response = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}`, cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken } });
      expect(response.statusCode).toBe(404);
    });

    it("GET /ai-analysis/:id/agents returns each agent with its own findings", async () => {
      const response = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/agents`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(200);
      const { agents } = response.json();
      const security = agents.find((a: { agent: string }) => a.agent === "SECURITY");
      expect(security.findings).toHaveLength(1);
      expect(security.findings[0].title).toBe("Hardcoded secret");
    });

    it("GET /ai-analysis/:id/findings filters by severity and agent, and paginates", async () => {
      const bySeverity = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings?severity=HIGH`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(bySeverity.json().total).toBe(1);
      expect(bySeverity.json().findings[0].agent).toBe("SECURITY");

      const byAgent = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings?agent=ARCHITECTURE`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(byAgent.json().total).toBe(1);

      const byConfidence = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings?minConfidence=0.8`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(byConfidence.json().total).toBe(1);
      expect(byConfidence.json().findings[0].title).toBe("Hardcoded secret");

      const paged = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings?pageSize=1&page=1`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(paged.json().findings).toHaveLength(1);
      expect(paged.json().total).toBe(2);
    });

    it("GET /ai-analysis/:id/findings/:findingId returns one finding with citations and its owning agent", async () => {
      const response = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings/${securityFindingId}`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.agent).toBe("SECURITY");
      expect(body.citations).toEqual([{ filePath: "src/b.ts", startLine: 3, endLine: 4, symbolName: null }]);
    });

    it("GET /ai-analysis/:id/findings/:findingId returns 404 for another user", async () => {
      const response = await app.inject({ method: "GET", url: `/ai-analysis/${aiAnalysisRunId}/findings/${securityFindingId}`, cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken } });
      expect(response.statusCode).toBe(404);
    });

    it("GET /repositories/:id/ai-analysis lists this repository's runs, ownership-scoped", async () => {
      const response = await app.inject({ method: "GET", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(200);
      expect(response.json().aiAnalyses).toHaveLength(1);

      const forbidden = await app.inject({ method: "GET", url: `/repositories/${repoReady.id}/ai-analysis`, cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken } });
      expect(forbidden.statusCode).toBe(404);
    });

    it("rejects a malformed id with 422", async () => {
      const response = await app.inject({ method: "GET", url: "/ai-analysis/not-a-valid-cuid", cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken } });
      expect(response.statusCode).toBe(422);
    });
  });
});

describe.skipIf(dbAvailable)("AI analysis (live database)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
