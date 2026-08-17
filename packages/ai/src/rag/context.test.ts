import { describe, expect, it } from "vitest";
import type { RetrievalResultDto } from "@developer-platform/shared";
import { buildRagContext } from "./context.js";
import { DEFAULT_RAG_CONTEXT_BUDGET } from "./types.js";

function result(overrides: Partial<RetrievalResultDto> & Pick<RetrievalResultDto, "chunkId" | "content">): RetrievalResultDto {
  return {
    fileId: "file-1",
    filePath: "src/example.ts",
    symbolName: null,
    language: "TypeScript",
    startLine: 1,
    endLine: 10,
    semanticScore: 0.9,
    lexicalScore: null,
    finalScore: 0.9,
    ...overrides,
  };
}

describe("buildRagContext — ordering and citations", () => {
  it("preserves the input order (assumed already rank-sorted)", () => {
    const results = [
      result({ chunkId: "c1", content: "first", finalScore: 0.95 }),
      result({ chunkId: "c2", content: "second", finalScore: 0.8 }),
    ];
    const context = buildRagContext(results);
    expect(context.chunks.map((c) => c.chunkId)).toEqual(["c1", "c2"]);
  });

  it("builds a line-range citation for a chunk with both start and end line", () => {
    const context = buildRagContext([
      result({ chunkId: "c1", content: "x", filePath: "src/services/github.ts", startLine: 90, endLine: 121 }),
    ]);
    expect(context.chunks[0]!.citation).toBe("src/services/github.ts:90-121");
  });

  it("builds a single-line citation when startLine === endLine", () => {
    const context = buildRagContext([result({ chunkId: "c1", content: "x", startLine: 42, endLine: 42 })]);
    expect(context.chunks[0]!.citation).toBe("src/example.ts:42");
  });

  it("falls back to just the file path when no line range is known", () => {
    const context = buildRagContext([result({ chunkId: "c1", content: "x", startLine: null, endLine: null })]);
    expect(context.chunks[0]!.citation).toBe("src/example.ts");
  });

  it("carries filePath, symbolName, and line numbers through unchanged", () => {
    const context = buildRagContext([
      result({ chunkId: "c1", content: "x", filePath: "a.ts", symbolName: "validateOAuthState", startLine: 5, endLine: 9 }),
    ]);
    expect(context.chunks[0]!).toMatchObject({
      filePath: "a.ts",
      symbolName: "validateOAuthState",
      startLine: 5,
      endLine: 9,
    });
  });
});

describe("buildRagContext — budget", () => {
  it("caps the number of chunks at maxResults", () => {
    const results = Array.from({ length: 20 }, (_, i) => result({ chunkId: `c${i}`, content: "x".repeat(10) }));
    const context = buildRagContext(results, { maxResults: 5, maxCharacters: 100_000 });
    expect(context.chunks).toHaveLength(5);
    expect(context.truncated).toBe(15);
  });

  it("caps total content length at maxCharacters, keeping earlier (higher-ranked) chunks first", () => {
    const results = [
      result({ chunkId: "c1", content: "x".repeat(50) }),
      result({ chunkId: "c2", content: "y".repeat(50) }),
      result({ chunkId: "c3", content: "z".repeat(50) }),
    ];
    const context = buildRagContext(results, { maxResults: 10, maxCharacters: 100 });
    expect(context.chunks.map((c) => c.chunkId)).toEqual(["c1", "c2"]);
    expect(context.totalCharacters).toBe(100);
    expect(context.truncated).toBe(1);
  });

  it("skips an oversized chunk but still includes a smaller, lower-ranked one that fits", () => {
    const results = [
      result({ chunkId: "big", content: "x".repeat(90) }),
      result({ chunkId: "small", content: "y".repeat(5) }),
    ];
    const context = buildRagContext(results, { maxResults: 10, maxCharacters: 50 });
    expect(context.chunks.map((c) => c.chunkId)).toEqual(["small"]);
    expect(context.truncated).toBe(1);
  });

  it("never splits a single chunk's content to fit the budget", () => {
    const results = [result({ chunkId: "c1", content: "x".repeat(200) })];
    const context = buildRagContext(results, { maxCharacters: 50 });
    expect(context.chunks).toHaveLength(0);
    expect(context.truncated).toBe(1);
  });

  it("uses sensible defaults when no budget is given", () => {
    const context = buildRagContext([]);
    expect(context.chunks).toEqual([]);
    expect(context.truncated).toBe(0);
    // sanity check the defaults themselves are the documented values
    expect(DEFAULT_RAG_CONTEXT_BUDGET).toEqual({ maxResults: 10, maxCharacters: 12_000 });
  });
});
