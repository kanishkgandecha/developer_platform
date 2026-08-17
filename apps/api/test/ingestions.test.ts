import { randomBytes, createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as GitHubService from "../src/services/github.js";
import type * as QueueService from "../src/queue.js";

const mockGetBranchHeadSha = vi.fn();
const mockEnqueueIngestionJob = vi.fn();

vi.mock("../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubService>();
  return { ...actual, getBranchHeadSha: mockGetBranchHeadSha };
});

vi.mock("../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, enqueueIngestionJob: mockEnqueueIngestionJob };
});

const { buildApp } = await import("../src/app.js");
const { encryptToken } = await import("../src/services/crypto.js");

describe("unauthenticated access to ingestion endpoints", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it("POST /repositories/:id/ingestions returns 401 without a session", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/repositories/clsomefakeid00000000000000/ingestions",
    });
    expect(response.statusCode).toBe(401);
  });

  it("GET /repositories/:id/ingestions returns 401 without a session", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/repositories/clsomefakeid00000000000000/ingestions",
    });
    expect(response.statusCode).toBe(401);
  });

  it("GET /ingestions/:id returns 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/ingestions/clsomefakeid00000000000000" });
    expect(response.statusCode).toBe(401);
  });
});

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("repository ingestion (live database)", () => {
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

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.userId, userB.userId] } } });
    await app.close();
  });

  afterEach(() => {
    mockGetBranchHeadSha.mockReset();
    mockEnqueueIngestionJob.mockReset();
  });

  it("sets up two users, one repository owned by user A", async () => {
    userA = await createUserWithSession(81_000_000 + Number.parseInt(marker.slice(0, 4), 16), `ing-a-${marker}`);
    userB = await createUserWithSession(81_100_000 + Number.parseInt(marker.slice(0, 4), 16), `ing-b-${marker}`);

    repoA = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 501,
        owner: "user-a",
        name: "repo-a",
        fullName: "user-a/repo-a",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-a",
      },
    });

    expect(repoA.id).toBeTruthy();
  });

  it("POST /repositories/:id/ingestions returns 404 for a repository owned by someone else", async () => {
    mockGetBranchHeadSha.mockResolvedValue("deadbeef");
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);
    expect(mockEnqueueIngestionJob).not.toHaveBeenCalled();
  });

  it("creates a new QUEUED ingestion and enqueues a job", async () => {
    mockGetBranchHeadSha.mockResolvedValue("sha-0001");
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ status: "QUEUED", commitSha: "sha-0001", progress: 0 });
    expect(mockEnqueueIngestionJob).toHaveBeenCalledWith({
      ingestionId: body.id,
      repositoryId: repoA.id,
    });
  });

  it("returns 409 (not a duplicate row) when an ingestion for the same commit is already active", async () => {
    mockGetBranchHeadSha.mockResolvedValue("sha-0001"); // same SHA as the previous test
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(409);
    expect(mockEnqueueIngestionJob).not.toHaveBeenCalled();

    const count = await prisma.ingestion.count({ where: { repositoryId: repoA.id, commitSha: "sha-0001" } });
    expect(count).toBe(1); // still exactly one row for this commit — no duplicate created
  });

  it("reuses (200, no new job) a COMPLETED ingestion for the same commit instead of redoing the work", async () => {
    await prisma.ingestion.updateMany({
      where: { repositoryId: repoA.id, commitSha: "sha-0001" },
      data: { status: "COMPLETED", progress: 100, fileCount: 10, sourceFileCount: 5, completedAt: new Date() },
    });

    mockGetBranchHeadSha.mockResolvedValue("sha-0001");
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "COMPLETED", commitSha: "sha-0001" });
    expect(mockEnqueueIngestionJob).not.toHaveBeenCalled();
  });

  it("allows retrying a FAILED ingestion for the same commit by reusing the row, not creating a new one", async () => {
    const before = await prisma.ingestion.findUniqueOrThrow({
      where: { repositoryId_commitSha: { repositoryId: repoA.id, commitSha: "sha-0001" } },
    });
    await prisma.ingestion.update({
      where: { id: before.id },
      data: { status: "FAILED", error: "something went wrong", completedAt: new Date() },
    });

    mockGetBranchHeadSha.mockResolvedValue("sha-0001");
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.id).toBe(before.id); // same row reused, not a new one
    expect(body.status).toBe("QUEUED");
    expect(body.error).toBeNull();
    expect(mockEnqueueIngestionJob).toHaveBeenCalledWith({ ingestionId: before.id, repositoryId: repoA.id });

    const count = await prisma.ingestion.count({ where: { repositoryId: repoA.id, commitSha: "sha-0001" } });
    expect(count).toBe(1);
  });

  it("creates a distinct ingestion for a new commit SHA on the same repository", async () => {
    mockGetBranchHeadSha.mockResolvedValue("sha-0002");
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().commitSha).toBe("sha-0002");

    const count = await prisma.ingestion.count({ where: { repositoryId: repoA.id } });
    expect(count).toBe(2); // sha-0001 and sha-0002, distinct rows
  });

  it("GET /repositories/:id/ingestions lists this repository's ingestions, ownership-scoped", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().ingestions).toHaveLength(2);
  });

  it("GET /repositories/:id/ingestions returns 404 for another user", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/repositories/${repoA.id}/ingestions`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET /ingestions/:id returns the ingestion for its owner", async () => {
    const ingestion = await prisma.ingestion.findFirstOrThrow({ where: { repositoryId: repoA.id } });
    const response = await app.inject({
      method: "GET",
      url: `/ingestions/${ingestion.id}`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBe(ingestion.id);
  });

  it("GET /ingestions/:id returns 404 (not the row) for another user — no existence leak", async () => {
    const ingestion = await prisma.ingestion.findFirstOrThrow({ where: { repositoryId: repoA.id } });
    const response = await app.inject({
      method: "GET",
      url: `/ingestions/${ingestion.id}`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);
  });

  it("GET /ingestions/:id rejects a malformed id with 422", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/ingestions/not-a-valid-cuid",
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(422);
  });

  it("GET /repositories includes each repository's latest ingestion", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/repositories",
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(200);
    const repo = response.json().repositories.find((r: { id: string }) => r.id === repoA.id);
    expect(repo.latestIngestion).toMatchObject({ commitSha: "sha-0002" }); // most recently created
  });
});
