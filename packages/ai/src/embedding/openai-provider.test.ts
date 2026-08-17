import { APIError } from "openai";
import { describe, expect, it, vi } from "vitest";
import { createOpenAIEmbeddingProvider, type OpenAIEmbeddingsClient } from "./openai-provider.js";
import { EmbeddingProviderError } from "./types.js";

function apiError(status: number, message = "boom"): APIError {
  return new APIError(status, {}, message, new Headers());
}

function fakeResponse(count: number, model = "text-embedding-3-small", dimensions = 4) {
  return {
    model,
    data: Array.from({ length: count }, (_, index) => ({
      index,
      embedding: Array.from({ length: dimensions }, () => index),
    })),
  };
}

describe("createOpenAIEmbeddingProvider", () => {
  it("returns an empty array without calling the client for empty input", async () => {
    const create = vi.fn();
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 2,
      client: { embeddings: { create } },
    });

    expect(await provider.embedDocuments([])).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });

  it("batches requests according to batchSize", async () => {
    const create = vi.fn(async (params: { input: string[] }) => fakeResponse(params.input.length));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 2,
      client: { embeddings: { create } },
    });

    const results = await provider.embedDocuments(["a", "b", "c", "d", "e"]);

    expect(create).toHaveBeenCalledTimes(3); // [a,b] [c,d] [e]
    expect(results).toHaveLength(5);
    expect(create.mock.calls.map(([params]) => params.input)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("preserves input order even if the provider returns embeddings out of order", async () => {
    const create = vi.fn(async () => ({
      model: "text-embedding-3-small",
      data: [
        { index: 1, embedding: [1, 1, 1, 1] },
        { index: 0, embedding: [0, 0, 0, 0] },
      ],
    }));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      client: { embeddings: { create } },
    });

    const results = await provider.embedDocuments(["first", "second"]);
    expect(results[0]!.vector).toEqual([0, 0, 0, 0]);
    expect(results[1]!.vector).toEqual([1, 1, 1, 1]);
  });

  it("retries a 429 (rate limit) with backoff and eventually succeeds", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(apiError(429, "rate limited"))
      .mockRejectedValueOnce(apiError(429, "rate limited"))
      .mockResolvedValueOnce(fakeResponse(1));

    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      maxRetries: 3,
      retryDelayMs: 1,
      client: { embeddings: { create } },
    });

    const results = await provider.embedDocuments(["hello"]);
    expect(results).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("retries a 500 (transient server error) the same as a 429", async () => {
    const create = vi.fn().mockRejectedValueOnce(apiError(500, "internal error")).mockResolvedValueOnce(fakeResponse(1));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      retryDelayMs: 1,
      client: { embeddings: { create } },
    });

    await provider.embedDocuments(["hello"]);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxRetries and throws a retryable EmbeddingProviderError", async () => {
    const create = vi.fn().mockRejectedValue(apiError(429, "still limited"));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      maxRetries: 2,
      retryDelayMs: 1,
      client: { embeddings: { create } },
    });

    await expect(provider.embedDocuments(["hello"])).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      retryable: true,
    });
    expect(create).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });

  it("does not retry a non-retryable error (e.g. 401) and fails immediately", async () => {
    const create = vi.fn().mockRejectedValue(apiError(401, "invalid api key"));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-invalid",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      client: { embeddings: { create } },
    });

    await expect(provider.embedDocuments(["hello"])).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      retryable: false,
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("throws a non-retryable error for a malformed response (wrong item count)", async () => {
    const create = vi.fn(async () => fakeResponse(1)); // 2 inputs, 1 embedding back
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      client: { embeddings: { create } },
    });

    await expect(provider.embedDocuments(["a", "b"])).rejects.toBeInstanceOf(EmbeddingProviderError);
    await expect(provider.embedDocuments(["a", "b"])).rejects.toMatchObject({ retryable: false });
  });

  it("throws a non-retryable error for a malformed response (wrong vector dimension)", async () => {
    const create: OpenAIEmbeddingsClient["embeddings"]["create"] = async () => ({
      model: "text-embedding-3-small",
      data: [{ index: 0, embedding: [1, 2, 3] }], // 3 dims, provider configured for 4
    });
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      client: { embeddings: { create } },
    });

    await expect(provider.embedDocuments(["a"])).rejects.toMatchObject({
      name: "EmbeddingProviderError",
      retryable: false,
    });
  });

  it("never silently discards a failed batch — a failure always rejects, never resolves with partial/fake data", async () => {
    const create = vi.fn().mockRejectedValue(apiError(400, "bad request"));
    const provider = createOpenAIEmbeddingProvider({
      apiKey: "sk-test",
      model: "text-embedding-3-small",
      dimensions: 4,
      batchSize: 10,
      client: { embeddings: { create } },
    });

    await expect(provider.embedDocuments(["a"])).rejects.toThrow();
  });
});
