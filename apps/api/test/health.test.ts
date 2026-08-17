import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("GET /health", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("responds 200 with the expected shape, whether or not dependencies are live", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body).toMatchObject({
      status: expect.stringMatching(/^(ok|degraded)$/),
      environment: expect.any(String),
      timestamp: expect.any(String),
      checks: {
        database: expect.stringMatching(/^(ok|error)$/),
        redis: expect.stringMatching(/^(ok|error)$/),
        worker: expect.stringMatching(/^(ok|error)$/),
        githubOAuth: expect.stringMatching(/^(configured|not_configured)$/),
      },
    });
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });
});

describe("unmatched routes", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("returns a structured 404", async () => {
    const response = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { statusCode: 404 } });
  });
});
