import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const validEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "a".repeat(32),
  GITHUB_CLIENT_ID: "test-client-id",
  GITHUB_CLIENT_SECRET: "test-client-secret",
  GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  WEB_URL: "http://localhost:3000",
  API_PUBLIC_URL: "http://localhost:4000",
};

describe("loadEnv", () => {
  it("parses a fully valid environment", () => {
    const env = loadEnv(validEnv);
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(env.NODE_ENV).toBe("test");
  });

  it("defaults NODE_ENV to development when unset", () => {
    const { NODE_ENV: _omit, ...rest } = validEnv;
    const env = loadEnv(rest);
    expect(env.NODE_ENV).toBe("development");
  });

  it("throws a single readable error listing all problems", () => {
    expect(() => loadEnv({})).toThrowError(/DATABASE_URL/);
  });

  it("lists every missing required variable in one error, not just the first", () => {
    try {
      loadEnv({});
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/GITHUB_CLIENT_ID/);
      expect(message).toMatch(/GITHUB_TOKEN_ENCRYPTION_KEY/);
      expect(message).toMatch(/WEB_URL/);
    }
  });

  it("rejects a SESSION_SECRET shorter than 32 characters", () => {
    expect(() => loadEnv({ ...validEnv, SESSION_SECRET: "too-short" })).toThrowError(
      /SESSION_SECRET/,
    );
  });

  it("rejects a non-URL DATABASE_URL", () => {
    expect(() => loadEnv({ ...validEnv, DATABASE_URL: "not-a-url" })).toThrowError(
      /DATABASE_URL/,
    );
  });

  it("rejects a GITHUB_TOKEN_ENCRYPTION_KEY that isn't a 32-byte base64 key", () => {
    expect(() =>
      loadEnv({ ...validEnv, GITHUB_TOKEN_ENCRYPTION_KEY: "too-short" }),
    ).toThrowError(/GITHUB_TOKEN_ENCRYPTION_KEY/);
  });

  it("accepts a well-formed GITHUB_TOKEN_ENCRYPTION_KEY", () => {
    const env = loadEnv(validEnv);
    expect(Buffer.from(env.GITHUB_TOKEN_ENCRYPTION_KEY, "base64")).toHaveLength(32);
  });

  it("rejects a non-URL WEB_URL / API_PUBLIC_URL", () => {
    expect(() => loadEnv({ ...validEnv, WEB_URL: "not-a-url" })).toThrowError(/WEB_URL/);
    expect(() => loadEnv({ ...validEnv, API_PUBLIC_URL: "not-a-url" })).toThrowError(
      /API_PUBLIC_URL/,
    );
  });

  it("leaves future-phase variables optional", () => {
    const env = loadEnv(validEnv);
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("defaults the Phase 3 ingestion limits when unset", () => {
    const env = loadEnv(validEnv);
    expect(env.INGESTION_WORKSPACE_DIR).toBe("./workspaces");
    expect(env.MAX_REPOSITORY_SIZE_MB).toBe(500);
    expect(env.MAX_FILE_SIZE_MB).toBe(10);
    expect(env.MAX_FILES_PER_REPOSITORY).toBe(5000);
  });

  it("coerces and honors an overridden ingestion limit", () => {
    const env = loadEnv({ ...validEnv, MAX_FILE_SIZE_MB: "25" });
    expect(env.MAX_FILE_SIZE_MB).toBe(25);
  });

  it("rejects a non-numeric ingestion limit", () => {
    expect(() => loadEnv({ ...validEnv, MAX_FILES_PER_REPOSITORY: "not-a-number" })).toThrowError(
      /MAX_FILES_PER_REPOSITORY/,
    );
  });
});
