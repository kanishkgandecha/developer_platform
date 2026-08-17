import { APIError } from "openai";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIChatProvider, type AIChatClient } from "./openai-provider.js";
import { AIProviderError } from "./types.js";

const schema = z.object({ summary: z.string(), score: z.number() });

function apiError(status: number, message = "boom"): APIError {
  return new APIError(status, {}, message, new Headers());
}

function chatResponse(content: unknown, model = "gpt-4.1-mini") {
  return { model, choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] };
}

describe("createOpenAIChatProvider", () => {
  it("returns a validated result on a well-formed response", async () => {
    const create = vi.fn(async (_params: Parameters<AIChatClient["chat"]["completions"]["create"]>[0]) =>
      chatResponse({ summary: "looks fine", score: 0.8 }),
    );
    const provider = createOpenAIChatProvider({ apiKey: "sk-test", model: "gpt-4.1-mini", client: { chat: { completions: { create } } } });

    const result = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" });
    expect(result).toEqual({ summary: "looks fine", score: 0.8 });
    expect(create).toHaveBeenCalledTimes(1);
    const call = create.mock.calls[0]![0];
    expect(call.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  it("retries a 429 (rate limit) with backoff and eventually succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(429))
      .mockResolvedValueOnce(chatResponse({ summary: "ok", score: 1 }));
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    const result = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" });
    expect(result).toEqual({ summary: "ok", score: 1 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries a malformed (non-JSON) response and succeeds on the next attempt", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(chatResponse("not valid json {"))
      .mockResolvedValueOnce(chatResponse({ summary: "ok", score: 1 }));
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    const result = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" });
    expect(result).toEqual({ summary: "ok", score: 1 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries a schema-invalid (but syntactically valid JSON) response", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(chatResponse({ summary: "missing score field" }))
      .mockResolvedValueOnce(chatResponse({ summary: "ok", score: 1 }));
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    const result = await provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" });
    expect(result).toEqual({ summary: "ok", score: 1 });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and throws a retryable AIProviderError — never fakes a result", async () => {
    const create = vi.fn(async () => chatResponse({ summary: "still missing score" }));
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      maxRetries: 2,
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    await expect(provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" })).rejects.toMatchObject({
      name: "AIProviderError",
      retryable: true,
    });
    expect(create).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry a non-retryable provider error (e.g. 401) and fails immediately", async () => {
    const create = vi.fn().mockRejectedValue(apiError(401, "invalid api key"));
    const provider = createOpenAIChatProvider({ apiKey: "sk-bad", model: "gpt-4.1-mini", client: { chat: { completions: { create } } } });

    await expect(provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" })).rejects.toMatchObject({
      name: "AIProviderError",
      retryable: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("treats an empty response as retryable, not a silent success", async () => {
    const create: AIChatClient["chat"]["completions"]["create"] = async () => ({ model: "gpt-4.1-mini", choices: [{ message: { content: null } }] });
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      maxRetries: 0,
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    await expect(provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test" })).rejects.toThrow(
      /empty response/,
    );
  });

  it("respects a per-request maxRetries override", async () => {
    const create = vi.fn(async () => chatResponse({ summary: "still bad" }));
    const provider = createOpenAIChatProvider({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      maxRetries: 5,
      retryDelayMs: 1,
      client: { chat: { completions: { create } } },
    });

    await expect(
      provider.generateStructured({ systemPrompt: "sys", userPrompt: "user", schema, schemaName: "test", maxRetries: 0 }),
    ).rejects.toBeInstanceOf(AIProviderError);
    expect(create).toHaveBeenCalledTimes(1); // maxRetries: 0 override — no retries at all
  });
});
