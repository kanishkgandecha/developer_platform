import { describe, expect, it } from "vitest";
import { checkDatabaseConnection, prisma } from "./index.js";

describe("checkDatabaseConnection", () => {
  it("resolves to a boolean rather than throwing, even against an unreachable database", async () => {
    // No live Postgres is guaranteed in this unit test run (see the
    // docker-compose based integration check in docs/development.md for the
    // live version) — what matters here is that a connection failure is
    // reported as `false`, not an unhandled rejection reaching the caller.
    const result = await checkDatabaseConnection();
    expect(typeof result).toBe("boolean");
  });

  it("exposes a single shared PrismaClient instance", () => {
    expect(prisma).toBeDefined();
  });
});
