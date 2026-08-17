import { randomBytes, createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as QueueService from "../src/queue.js";

// Deliberately the opposite setup from embeddings.test.ts: OPENAI_API_KEY is
// never set here, so `env.OPENAI_API_KEY` is undefined for this file's
// `app` — see packages/shared/src/env.ts's doc comment: "the application
// boots, the embedding feature reports not configured" is exactly the
// behavior this file proves at the HTTP layer.
delete process.env.OPENAI_API_KEY;

const mockEnqueueEmbeddingJob = vi.fn();
vi.mock("../src/queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof QueueService>();
  return { ...actual, enqueueEmbeddingJob: mockEnqueueEmbeddingJob };
});

const { buildApp } = await import("../src/app.js");
const { encryptToken } = await import("../src/services/crypto.js");

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("POST /repositories/:id/embeddings without OPENAI_API_KEY configured", () => {
  const app = buildApp();
  const marker = randomBytes(6).toString("hex");
  let userId: string;
  let sessionToken: string;
  let repositoryId: string;

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
    await app.close();
  });

  it("seeds a user and repository", async () => {
    const user = await prisma.user.create({
      data: {
        githubAccount: {
          create: {
            githubId: 84_000_000 + Number.parseInt(marker.slice(0, 4), 16),
            username: `em-nc-${marker}`,
            accessTokenEncrypted: encryptToken("fake-token"),
          },
        },
      },
    });
    userId = user.id;
    sessionToken = randomBytes(32).toString("base64url");
    await prisma.session.create({
      data: { userId, tokenHash: createHash("sha256").update(sessionToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000) },
    });
    const repository = await prisma.repository.create({
      data: {
        userId,
        githubId: 84_100_000 + Number.parseInt(marker.slice(0, 4), 16),
        owner: "user-nc",
        name: "repo-nc",
        fullName: "user-nc/repo-nc",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/user-nc/repo-nc",
      },
    });
    repositoryId = repository.id;
  });

  it("returns 503 rather than queuing a job doomed to fail", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/repositories/${repositoryId}/embeddings`,
      cookies: { [SESSION_COOKIE_NAME]: sessionToken },
    });
    expect(response.statusCode).toBe(503);
    expect(mockEnqueueEmbeddingJob).not.toHaveBeenCalled();
  });
});

describe.skipIf(dbAvailable)("POST /repositories/:id/embeddings without OPENAI_API_KEY configured", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
