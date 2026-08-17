import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createMockAIChatProvider } from "./mock-provider.js";

const schema = z.object({ summary: z.string(), score: z.number() });

describe("createMockAIChatProvider", () => {
  it("returns the responder's value once it's validated against the schema", async () => {
    const provider = createMockAIChatProvider({ responder: () => ({ summary: "ok", score: 0.5 }) });
    const result = await provider.generateStructured({
      systemPrompt: "sys",
      userPrompt: "user",
      schema,
      schemaName: "test",
    });
    expect(result).toEqual({ summary: "ok", score: 0.5 });
  });

  it("throws when the responder's value doesn't match the schema — never silently coerces", async () => {
    const provider = createMockAIChatProvider({ responder: () => ({ summary: "ok" }) }); // missing `score`
    await expect(
      provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" }),
    ).rejects.toThrow();
  });

  it("throws a clear error when no responder is configured, rather than returning a fake default", async () => {
    const provider = createMockAIChatProvider();
    await expect(
      provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" }),
    ).rejects.toThrow(/no responder configured/);
  });

  it("passes the request through to the responder so tests can assert on prompt content", async () => {
    let seenUserPrompt: string | undefined;
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenUserPrompt = request.userPrompt;
        return { summary: "ok", score: 1 };
      },
    });
    await provider.generateStructured({ systemPrompt: "sys", userPrompt: "specific evidence here", schema, schemaName: "test" });
    expect(seenUserPrompt).toBe("specific evidence here");
  });
});
