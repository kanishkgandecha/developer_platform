import { describe, expect, it } from "vitest";
import { buildDependencyGraph } from "./dependency-graph.js";
import { parseTypeScript } from "./typescript-parser.js";

describe("buildDependencyGraph", () => {
  it("resolves relative TypeScript imports to same-repository targets: A -> B, B -> C, A -> C", () => {
    const a = parseTypeScript(
      "src/a.ts",
      `import { b } from "./b";\nimport { c } from "./c";\nexport const x = b + c;`,
    );
    const b = parseTypeScript("src/b.ts", `import { c } from "./c";\nexport const b = c;`);
    const c = parseTypeScript("src/c.ts", `export const c = 1;`);

    const edges = buildDependencyGraph([a, b, c]);

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceFile: "src/a.ts", targetFile: "src/b.ts", external: false }),
        expect.objectContaining({ sourceFile: "src/a.ts", targetFile: "src/c.ts", external: false }),
        expect.objectContaining({ sourceFile: "src/b.ts", targetFile: "src/c.ts", external: false }),
      ]),
    );
  });

  it("resolves an import to an index file", () => {
    const a = parseTypeScript("src/a.ts", `import { thing } from "./lib";`);
    const index = parseTypeScript("src/lib/index.ts", `export const thing = 1;`);

    const edges = buildDependencyGraph([a, index]);
    expect(edges).toEqual([expect.objectContaining({ targetFile: "src/lib/index.ts", external: false })]);
  });

  it("marks a bare package specifier as external, never resolved", () => {
    const a = parseTypeScript("src/app.ts", `import fastify from "fastify";`);
    const edges = buildDependencyGraph([a]);
    expect(edges).toEqual([
      expect.objectContaining({ sourceFile: "src/app.ts", targetFile: null, external: true, specifier: "fastify" }),
    ]);
  });

  it("marks an unresolvable relative import as external rather than throwing", () => {
    const a = parseTypeScript("src/app.ts", `import { missing } from "./does-not-exist";`);
    const edges = buildDependencyGraph([a]);
    expect(edges).toEqual([expect.objectContaining({ targetFile: null, external: true })]);
  });

  it("never resolves heuristically-parsed (non-TS/JS) imports — always external", () => {
    const python = {
      path: "app.py",
      language: "Python",
      parseStrategy: "heuristic" as const,
      symbols: [],
      imports: [{ source: "os", kind: "IMPORT" as const, line: 1 }],
    };
    const edges = buildDependencyGraph([python]);
    expect(edges).toEqual([expect.objectContaining({ targetFile: null, external: true })]);
  });
});
