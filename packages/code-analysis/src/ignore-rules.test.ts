import { describe, expect, it } from "vitest";
import { isIgnoredDirectoryName } from "./ignore-rules.js";

describe("isIgnoredDirectoryName", () => {
  it.each(["node_modules", ".git", "dist", "build", ".next", "coverage", "__pycache__", "venv", "target", "vendor"])(
    "prunes %s",
    (name) => {
      expect(isIgnoredDirectoryName(name)).toBe(true);
    },
  );

  it.each(["src", "packages", "lib", "components", ".github"])("does not prune %s", (name) => {
    expect(isIgnoredDirectoryName(name)).toBe(false);
  });
});
