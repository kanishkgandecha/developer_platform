import { describe, expect, it } from "vitest";
import { chunkFile } from "./chunk-file.js";
import type { ChunkableSymbol } from "./types.js";

function sym(overrides: Partial<ChunkableSymbol> & Pick<ChunkableSymbol, "id" | "name" | "startLine" | "endLine">): ChunkableSymbol {
  return { kind: "FUNCTION", parentId: null, ...overrides };
}

describe("chunkFile — semantic boundaries", () => {
  it("chunks a class and its methods as one coherent chunk when the whole class fits", () => {
    const content = [
      "export class Greeter {",
      "  constructor(private name: string) {}",
      "",
      "  greet(): string {",
      "    return `hello ${this.name}`;",
      "  }",
      "}",
    ].join("\n");

    const symbols: ChunkableSymbol[] = [
      sym({ id: "s1", name: "Greeter", kind: "CLASS", startLine: 1, endLine: 7 }),
      sym({ id: "s2", name: "greet", kind: "METHOD", startLine: 4, endLine: 6, parentId: "s1" }),
    ];

    const chunks = chunkFile({ filePath: "a.ts", language: "TypeScript", content, symbols });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunkIndex: 0, symbolId: "s1", symbolName: "Greeter", startLine: 1, endLine: 7 });
    expect(chunks[0]!.content).toBe(content);
  });

  it("gives module-level functions their own chunks, separate from gaps between them", () => {
    const content = [
      "import { z } from 'zod';", // line 1 — gap (import, no symbol)
      "",
      "function add(a: number, b: number) {", // line 3
      "  return a + b;",
      "}",
      "",
      "function subtract(a: number, b: number) {", // line 7
      "  return a - b;",
      "}",
    ].join("\n");

    const symbols: ChunkableSymbol[] = [
      sym({ id: "s1", name: "add", startLine: 3, endLine: 5 }),
      sym({ id: "s2", name: "subtract", startLine: 7, endLine: 9 }),
    ];

    const chunks = chunkFile({ filePath: "math.ts", language: "TypeScript", content, symbols });

    // The import-line gap is below minChars and dropped.
    expect(chunks.map((c) => c.symbolName)).toEqual(["add", "subtract"]);
    expect(chunks[0]!.content).toContain("function add");
    expect(chunks[1]!.content).toContain("function subtract");
    // Sequential, source-ordered indices.
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1]);
  });

  it("keeps a substantial gap (e.g. a real header comment) as its own chunk", () => {
    const header = "// ".concat("This module implements the widget registry. ".repeat(3));
    const content = [header, "", "function widget() {", "  return 1;", "}"].join("\n");
    const symbols: ChunkableSymbol[] = [sym({ id: "s1", name: "widget", startLine: 3, endLine: 5 })];

    const chunks = chunkFile({ filePath: "w.ts", language: "TypeScript", content, symbols });

    expect(chunks[0]!.symbolId).toBeNull();
    expect(chunks[0]!.content).toContain("widget registry");
    expect(chunks[1]!.symbolName).toBe("widget");
  });
});

describe("chunkFile — oversized regions", () => {
  it("falls back to line-based splitting for a single oversized function with no nested symbols, preserving symbolId on every sub-chunk", () => {
    const bodyLines = Array.from({ length: 400 }, (_, i) => `  const line${i} = ${i};`);
    const content = ["function huge() {", ...bodyLines, "}"].join("\n");
    const symbols: ChunkableSymbol[] = [sym({ id: "s1", name: "huge", startLine: 1, endLine: bodyLines.length + 2 })];

    const chunks = chunkFile({ filePath: "huge.ts", language: "TypeScript", content, symbols });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.symbolId).toBe("s1");
      expect(chunk.symbolName).toBe("huge");
      expect(chunk.charCount).toBeLessThanOrEqual(4000);
    }
    // Chunks cover the region in order with no gaps.
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(bodyLines.length + 2);
  });

  it("splits an oversized class by its methods before falling back to lines", () => {
    const methodBody = (n: number) => [`  method${n}(): number {`, `    return ${n};`, `  }`];
    const methodLineCount = 3;
    const methodCount = 10;
    const methodBlocks = Array.from({ length: methodCount }, (_, i) => methodBody(i));
    const classLines = ["class Big {", ...methodBlocks.flat(), "}"];
    const content = classLines.join("\n");

    let line = 2;
    const methodSymbols: ChunkableSymbol[] = methodBlocks.map((_, i) => {
      const startLine = line;
      const endLine = line + methodLineCount - 1;
      line = endLine + 1;
      return sym({ id: `m${i}`, name: `method${i}`, kind: "METHOD", startLine, endLine, parentId: "cls" });
    });
    const symbols: ChunkableSymbol[] = [
      sym({ id: "cls", name: "Big", kind: "CLASS", startLine: 1, endLine: classLines.length }),
      ...methodSymbols,
    ];

    // A small maxChars forces the class (which otherwise comfortably fits
    // in the default 4000-char budget) to be treated as oversized, so the
    // method-boundary sub-splitting path is exercised deterministically
    // rather than depending on how much text this fixture happens to contain.
    const config = { maxChars: 200, targetChars: 150, overlapLines: 0 };
    const chunks = chunkFile({ filePath: "big.ts", language: "TypeScript", content, symbols }, config);

    expect(chunks.length).toBeGreaterThan(1);
    // Every emitted chunk should be attributed to an individual method, not the whole class as one blob.
    const methodNames = new Set(chunks.map((c) => c.symbolName));
    expect(methodNames.has("method0")).toBe(true);
    expect(methodNames.has(`method${methodCount - 1}`)).toBe(true);
    for (const chunk of chunks) {
      expect(chunk.charCount).toBeLessThanOrEqual(config.maxChars);
    }
  });
});

describe("chunkFile — fallback (no symbols)", () => {
  it("still produces line-based chunks for a file with no symbols at all", () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");

    const chunks = chunkFile({ filePath: "data.txt", language: "Text", content, symbols: [] });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.symbolId).toBeNull();
    }
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks.at(-1)!.endLine).toBe(200);
  });

  it("produces a single chunk for a short file with no symbols", () => {
    const content = "config:\n  enabled: true\n  retries: 3\n";
    const chunks = chunkFile({ filePath: "config.yaml", language: "YAML", content, symbols: [] });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content.trimEnd()).toBe(content.trimEnd());
  });
});

describe("chunkFile — empty and trivial files", () => {
  it("returns no chunks for an empty file", () => {
    expect(chunkFile({ filePath: "empty.ts", language: "TypeScript", content: "", symbols: [] })).toEqual([]);
  });

  it("returns no chunks for a whitespace-only file", () => {
    expect(chunkFile({ filePath: "blank.ts", language: "TypeScript", content: "   \n\n\t\n", symbols: [] })).toEqual([]);
  });
});

describe("chunkFile — comments", () => {
  it("chunks a comment-only file as its own fallback chunk", () => {
    const content = [
      "/**",
      " * This file intentionally contains only documentation — no executable code,",
      " * describing the module's purpose at length so it clears the minimum chunk size.",
      " */",
    ].join("\n");

    const chunks = chunkFile({ filePath: "doc.ts", language: "TypeScript", content, symbols: [] });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("documentation");
  });
});

describe("chunkFile — multiline constructs", () => {
  it("keeps a multi-line template literal inside its enclosing function's chunk", () => {
    const content = [
      "function render() {",
      "  return `",
      "    <div>",
      "      multi-line",
      "      template",
      "    </div>",
      "  `;",
      "}",
    ].join("\n");
    const symbols: ChunkableSymbol[] = [sym({ id: "s1", name: "render", startLine: 1, endLine: 8 })];

    const chunks = chunkFile({ filePath: "render.ts", language: "TypeScript", content, symbols });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("multi-line");
    expect(chunks[0]!.content).toContain("</div>");
  });
});

describe("chunkFile — deterministic hashes", () => {
  it("produces identical chunks and hashes across repeated calls with the same input", () => {
    const content = [
      "function a() { return 1; }",
      "",
      "function b() { return 2; }",
    ].join("\n");
    const symbols: ChunkableSymbol[] = [
      sym({ id: "s1", name: "a", startLine: 1, endLine: 1 }),
      sym({ id: "s2", name: "b", startLine: 3, endLine: 3 }),
    ];

    const first = chunkFile({ filePath: "ab.ts", language: "TypeScript", content, symbols });
    const second = chunkFile({ filePath: "ab.ts", language: "TypeScript", content, symbols });

    expect(first).toEqual(second);
    expect(first.map((c) => c.contentHash)).toEqual(second.map((c) => c.contentHash));
  });

  it("changes the hash when the content changes, but not when only an unrelated chunk changes", () => {
    const symbols: ChunkableSymbol[] = [
      sym({ id: "s1", name: "a", startLine: 1, endLine: 1 }),
      sym({ id: "s2", name: "b", startLine: 3, endLine: 3 }),
    ];
    const before = chunkFile({
      filePath: "ab.ts",
      language: "TypeScript",
      content: ["function a() { return 1; }", "", "function b() { return 2; }"].join("\n"),
      symbols,
    });
    const after = chunkFile({
      filePath: "ab.ts",
      language: "TypeScript",
      content: ["function a() { return 1; }", "", "function b() { return 999; }"].join("\n"),
      symbols,
    });

    expect(before[0]!.contentHash).toBe(after[0]!.contentHash); // `a` unchanged
    expect(before[1]!.contentHash).not.toBe(after[1]!.contentHash); // `b` changed
  });

  it("produces a different hash for the same content at a different chunk index", () => {
    const content = "same content, different position";
    const a = chunkFile({ filePath: "x.ts", language: "TypeScript", content, symbols: [] });
    const b = chunkFile({ filePath: "y.ts", language: "TypeScript", content, symbols: [] });
    expect(a[0]!.content).toBe(b[0]!.content);
    expect(a[0]!.contentHash).not.toBe(b[0]!.contentHash); // filePath differs, so the hash differs too
  });
});

describe("chunkFile — configurable limits", () => {
  it("respects a smaller targetChars/maxChars override", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile(
      { filePath: "cfg.ts", language: "TypeScript", content, symbols: [] },
      { targetChars: 100, maxChars: 150, overlapLines: 1 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.charCount).toBeLessThanOrEqual(150);
    }
  });
});
