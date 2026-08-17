import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspace } from "../../src/ingestion/scan.js";

describe("scanWorkspace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ingestion-scan-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies files it finds, at every depth", async () => {
    await writeFile(join(dir, "index.ts"), "export {};");
    await writeFile(join(dir, "README.md"), "# hi");
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "app.py"), "print('hi')");

    const files = await scanWorkspace(dir);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

    expect(byPath["index.ts"]).toMatchObject({ category: "SOURCE", language: "TypeScript", isSource: true });
    expect(byPath["README.md"]).toMatchObject({ category: "DOCUMENTATION", isSource: false });
    expect(byPath["src/app.py"]).toMatchObject({ category: "SOURCE", language: "Python" });
  });

  it("prunes ignored directories entirely — their contents never appear", async () => {
    await mkdir(join(dir, "node_modules", "some-package"), { recursive: true });
    await writeFile(join(dir, "node_modules", "some-package", "index.js"), "module.exports = {};");
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(join(dir, "real-source.ts"), "export {};");

    const files = await scanWorkspace(dir);
    const paths = files.map((f) => f.path);

    expect(paths).toContain("real-source.ts");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
  });

  it("records the correct byte size for each file", async () => {
    await writeFile(join(dir, "sized.txt"), "0123456789"); // exactly 10 bytes
    const files = await scanWorkspace(dir);
    expect(files.find((f) => f.path === "sized.txt")?.size).toBe(10);
  });

  it("returns an empty array for an empty workspace", async () => {
    const files = await scanWorkspace(dir);
    expect(files).toEqual([]);
  });
});
