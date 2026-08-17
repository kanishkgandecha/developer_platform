import { describe, expect, it } from "vitest";
import { isStaleActiveRun } from "./job-staleness.js";

describe("isStaleActiveRun", () => {
  it("returns false for a run updated moments ago", () => {
    expect(isStaleActiveRun(new Date(), 30)).toBe(false);
  });

  it("returns false for a run updated just under the threshold ago", () => {
    const updatedAt = new Date(Date.now() - 29 * 60_000);
    expect(isStaleActiveRun(updatedAt, 30)).toBe(false);
  });

  it("returns true for a run updated well past the threshold ago", () => {
    const updatedAt = new Date(Date.now() - 45 * 60_000);
    expect(isStaleActiveRun(updatedAt, 30)).toBe(true);
  });

  it("respects a custom threshold", () => {
    const updatedAt = new Date(Date.now() - 5 * 60_000);
    expect(isStaleActiveRun(updatedAt, 1)).toBe(true);
    expect(isStaleActiveRun(updatedAt, 10)).toBe(false);
  });
});
