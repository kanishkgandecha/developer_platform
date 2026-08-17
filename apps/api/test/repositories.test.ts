import { randomBytes, createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import { buildApp } from "../src/app.js";

const dbAvailable = await checkDatabaseConnection();

describe("unauthenticated access to /repositories", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it("GET /repositories returns 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/repositories" });
    expect(response.statusCode).toBe(401);
  });

  it("GET /repositories/:id returns 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/repositories/clsomefakeid00000000000000" });
    expect(response.statusCode).toBe(401);
  });

  it("DELETE /repositories/:id returns 401 without a session", async () => {
    const response = await app.inject({ method: "DELETE", url: "/repositories/clsomefakeid00000000000000" });
    expect(response.statusCode).toBe(401);
  });

  it("POST /repositories/connect returns 401 without a session", async () => {
    const response = await app.inject({ method: "POST", url: "/repositories/connect" });
    expect(response.statusCode).toBe(401);
  });
});

describe.runIf(dbAvailable)("repository authorization (live database)", () => {
  const app = buildApp();
  // Two separate users, each with their own repository — the core of the
  // IDOR test suite is proving user A can never read/delete user B's row.
  const marker = randomBytes(6).toString("hex");

  async function createUserWithSession(githubId: number, username: string) {
    const user = await prisma.user.create({
      data: {
        githubAccount: {
          create: {
            githubId,
            username,
            accessTokenEncrypted: "unused-in-this-test",
          },
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
  let repoIdOwnedByA: string;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userA.userId, userB.userId] } } });
    await app.close();
  });

  it("sets up two users, each with their own repository", async () => {
    // GitHub ids fixed-but-unique-per-run via `marker` so repeated local
    // test runs never collide on the GitHubAccount.githubId unique constraint.
    userA = await createUserWithSession(80_000_000 + Number.parseInt(marker.slice(0, 4), 16), `user-a-${marker}`);
    userB = await createUserWithSession(80_100_000 + Number.parseInt(marker.slice(0, 4), 16), `user-b-${marker}`);

    const repoA = await prisma.repository.create({
      data: {
        userId: userA.userId,
        githubId: 1,
        owner: "user-a",
        name: "repo-a",
        fullName: "user-a/repo-a",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-a/repo-a",
      },
    });
    repoIdOwnedByA = repoA.id;

    await prisma.repository.create({
      data: {
        userId: userB.userId,
        githubId: 2,
        owner: "user-b",
        name: "repo-b",
        fullName: "user-b/repo-b",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-b/repo-b",
      },
    });

    expect(repoIdOwnedByA).toBeTruthy();
  });

  it("GET /repositories only returns the authenticated user's own repositories", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/repositories",
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });

    expect(response.statusCode).toBe(200);
    const { repositories } = response.json();
    expect(repositories).toHaveLength(1);
    expect(repositories[0].fullName).toBe("user-a/repo-a");
  });

  it("GET /repositories/:id returns the repository when it belongs to the caller", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/repositories/${repoIdOwnedByA}`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().fullName).toBe("user-a/repo-a");
  });

  it("GET /repositories/:id returns 404 (not 403) when the repository belongs to someone else — no existence leak", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/repositories/${repoIdOwnedByA}`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);
  });

  it("DELETE /repositories/:id returns 404 when the repository belongs to someone else, and does not delete it", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/repositories/${repoIdOwnedByA}`,
      cookies: { [SESSION_COOKIE_NAME]: userB.sessionToken },
    });
    expect(response.statusCode).toBe(404);

    const stillExists = await prisma.repository.findUnique({ where: { id: repoIdOwnedByA } });
    expect(stillExists).not.toBeNull();
  });

  it("GET /repositories/:id rejects a malformed id with 400, not a database error", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/repositories/not-a-valid-cuid",
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(400);
  });

  it("DELETE /repositories/:id returns 204 and actually removes the caller's own repository", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/repositories/${repoIdOwnedByA}`,
      cookies: { [SESSION_COOKIE_NAME]: userA.sessionToken },
    });
    expect(response.statusCode).toBe(204);

    const gone = await prisma.repository.findUnique({ where: { id: repoIdOwnedByA } });
    expect(gone).toBeNull();
  });
});
