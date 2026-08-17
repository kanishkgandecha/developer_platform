import { describe, expect, it } from "vitest";
import { DEFAULT_JOB_OPTIONS } from "../src/job-runner.js";

describe("DEFAULT_JOB_OPTIONS", () => {
  it("bounds retries with exponential backoff", () => {
    expect(DEFAULT_JOB_OPTIONS.attempts).toBe(3);
    expect(DEFAULT_JOB_OPTIONS.backoff).toEqual({ type: "exponential", delay: 1000 });
  });

  it("caps how long completed/failed jobs are retained", () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnComplete).toMatchObject({ age: expect.any(Number) });
    expect(DEFAULT_JOB_OPTIONS.removeOnFail).toMatchObject({ age: expect.any(Number) });
  });
});
