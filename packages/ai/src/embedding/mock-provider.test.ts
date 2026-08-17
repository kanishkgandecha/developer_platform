import { describe, expect, it } from "vitest";
import { createMockEmbeddingProvider } from "./mock-provider.js";

describe("createMockEmbeddingProvider", () => {
  it("produces a vector of the configured dimension for every input", async () => {
    const provider = createMockEmbeddingProvider({ dimensions: 16 });
    const results = await provider.embedDocuments(["hello", "world"]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.vector).toHaveLength(16);
      expect(result.dimensions).toBe(16);
      expect(result.model).toBe(provider.model);
    }
  });

  it("is deterministic — the same text always produces the same vector", async () => {
    const provider = createMockEmbeddingProvider();
    const first = await provider.embedDocuments(["function foo() { return 1; }"]);
    const second = await provider.embedDocuments(["function foo() { return 1; }"]);
    expect(first[0]!.vector).toEqual(second[0]!.vector);
  });

  it("produces different vectors for different text", async () => {
    const provider = createMockEmbeddingProvider();
    const results = await provider.embedDocuments(["function foo() {}", "function bar() {}"]);
    expect(results[0]!.vector).not.toEqual(results[1]!.vector);
  });

  it("returns an empty array for an empty input", async () => {
    const provider = createMockEmbeddingProvider();
    expect(await provider.embedDocuments([])).toEqual([]);
  });

  it("preserves input order", async () => {
    const provider = createMockEmbeddingProvider({ dimensions: 8 });
    const texts = ["a", "b", "c"];
    const results = await provider.embedDocuments(texts);
    const individually = await Promise.all(texts.map((t) => provider.embedDocuments([t]).then((r) => r[0]!)));
    expect(results.map((r) => r.vector)).toEqual(individually.map((r) => r.vector));
  });
});
