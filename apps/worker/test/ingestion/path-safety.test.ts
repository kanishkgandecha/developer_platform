import { describe, expect, it } from "vitest";
import { resolveSafeEntryPath, UnsafeArchivePathError } from "../../src/ingestion/path-safety.js";

describe("resolveSafeEntryPath", () => {
  const workspace = "/tmp/workspace-under-test";

  it("resolves a normal relative path inside the workspace", () => {
    const resolved = resolveSafeEntryPath(workspace, "src/index.ts");
    expect(resolved).toBe("/tmp/workspace-under-test/src/index.ts");
  });

  it("resolves a nested relative path inside the workspace", () => {
    const resolved = resolveSafeEntryPath(workspace, "a/b/c/d.txt");
    expect(resolved).toBe("/tmp/workspace-under-test/a/b/c/d.txt");
  });

  it("rejects a path traversal escape (../../etc/passwd)", () => {
    expect(() => resolveSafeEntryPath(workspace, "../../etc/passwd")).toThrow(UnsafeArchivePathError);
  });

  it("rejects a single-level escape (../sibling-file)", () => {
    expect(() => resolveSafeEntryPath(workspace, "../sibling-file")).toThrow(UnsafeArchivePathError);
  });

  it("rejects an absolute path pointing outside the workspace", () => {
    expect(() => resolveSafeEntryPath(workspace, "/etc/passwd")).toThrow(UnsafeArchivePathError);
  });

  it("rejects a path that traverses out and back to escape via a sneaky combination", () => {
    expect(() => resolveSafeEntryPath(workspace, "src/../../outside/file")).toThrow(UnsafeArchivePathError);
  });

  it("rejects a sibling directory that merely shares the workspace path as a prefix", () => {
    // "/tmp/workspace-under-test-evil" starts with the workspace string but
    // is not inside it — a naive `startsWith` check would wrongly accept this.
    expect(() => resolveSafeEntryPath(workspace, "../workspace-under-test-evil/file")).toThrow(
      UnsafeArchivePathError,
    );
  });

  it("accepts the workspace root itself", () => {
    expect(resolveSafeEntryPath(workspace, ".")).toBe(workspace);
  });
});
