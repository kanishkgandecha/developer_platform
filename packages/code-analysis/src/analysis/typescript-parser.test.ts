import { describe, expect, it } from "vitest";
import { parseTypeScript } from "./typescript-parser.js";

describe("parseTypeScript", () => {
  it("extracts an exported function declaration with its parameter count and complexity", () => {
    const result = parseTypeScript(
      "src/util.ts",
      `export function add(a: number, b: number): number {
  return a + b;
}`,
    );

    expect(result.parseStrategy).toBe("ast");
    expect(result.symbols).toHaveLength(1);
    const fn = result.symbols[0]!;
    expect(fn).toMatchObject({ name: "add", kind: "FUNCTION", exported: true, parameterCount: 2, complexity: 1 });
    expect(fn.startLine).toBe(1);
    expect(fn.endLine).toBe(3);
  });

  it("extracts a class with its methods, marking the class as the method's parent", () => {
    const result = parseTypeScript(
      "src/thing.ts",
      `export class Thing {
  private value = 0;

  getValue(): number {
    return this.value;
  }
}`,
    );

    const cls = result.symbols.find((s) => s.kind === "CLASS");
    const method = result.symbols.find((s) => s.kind === "METHOD");
    expect(cls).toMatchObject({ name: "Thing", exported: true });
    expect(method).toMatchObject({ name: "getValue", parentName: "Thing", parameterCount: 0 });
  });

  it("extracts interfaces, type aliases, and enums", () => {
    const result = parseTypeScript(
      "src/types.ts",
      `export interface User { id: string }
export type Id = string;
export enum Role { Admin, Member }`,
    );

    expect(result.symbols.map((s) => s.kind).sort()).toEqual(["ENUM", "INTERFACE", "TYPE"]);
    expect(result.symbols.every((s) => s.exported)).toBe(true);
  });

  it("extracts a const arrow function as a top-level FUNCTION symbol", () => {
    const result = parseTypeScript("src/handler.ts", `export const handler = (req: unknown, res: unknown) => {};`);
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: "handler", kind: "FUNCTION", exported: true, parameterCount: 2 }),
    ]);
  });

  it("distinguishes const bindings from let/var as CONSTANT vs VARIABLE", () => {
    const result = parseTypeScript("src/vars.ts", `const PI = 3.14;\nlet counter = 0;`);
    expect(result.symbols).toEqual([
      expect.objectContaining({ name: "PI", kind: "CONSTANT" }),
      expect.objectContaining({ name: "counter", kind: "VARIABLE" }),
    ]);
  });

  it("handles nested symbols: a method inside a class inside an exported module stays attached to its class", () => {
    const result = parseTypeScript(
      "src/nested.ts",
      `export class Outer {
  method1() {}
  method2() {}
}`,
    );
    const methods = result.symbols.filter((s) => s.kind === "METHOD");
    expect(methods).toHaveLength(2);
    expect(methods.every((m) => m.parentName === "Outer")).toBe(true);
  });

  it("extracts ES imports, require(), and dynamic import()", () => {
    const result = parseTypeScript(
      "src/imports.ts",
      `import { readFile } from "node:fs";
import fastify from "fastify";
const legacy = require("./legacy");
async function load() {
  await import("./lazy");
}`,
    );

    expect(result.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "node:fs", kind: "IMPORT" }),
        expect.objectContaining({ source: "fastify", kind: "IMPORT" }),
        expect.objectContaining({ source: "./legacy", kind: "REQUIRE" }),
        expect.objectContaining({ source: "./lazy", kind: "DYNAMIC_IMPORT" }),
      ]),
    );
  });

  it("computes higher complexity for functions with more branches", () => {
    const simple = parseTypeScript("a.ts", `function simple() { return 1; }`);
    const branchy = parseTypeScript(
      "b.ts",
      `function branchy(x: number) {
  if (x > 0) {
    return 1;
  } else if (x < 0) {
    return -1;
  }
  for (let i = 0; i < x; i++) {
    if (i % 2 === 0 && x > 10) continue;
  }
  return 0;
}`,
    );

    expect(simple.symbols[0]!.complexity).toBe(1);
    expect(branchy.symbols[0]!.complexity).toBeGreaterThan(simple.symbols[0]!.complexity!);
  });

  it("does not attribute a nested function's complexity to its enclosing function", () => {
    const result = parseTypeScript(
      "c.ts",
      `export function outer() {
  function inner() {
    if (true) return 1;
    if (true) return 2;
    if (true) return 3;
  }
  return inner();
}`,
    );
    const outer = result.symbols.find((s) => s.name === "outer")!;
    const inner = result.symbols.find((s) => s.name === "inner")!;
    expect(outer.complexity).toBe(1);
    expect(inner.complexity).toBe(4);
  });
});
