import { describe, expect, it } from "vitest";
import { EmbeddingProviderError } from "@developer-platform/ai";
import { EmbeddingNotConfiguredError, userFacingMessageFor } from "../../src/embedding/pipeline.js";
import { GitHubArchiveError } from "../../src/services/github-archive.js";
import { ExtractionLimitError } from "../../src/ingestion/archive.js";
import { UnsafeArchivePathError } from "../../src/ingestion/path-safety.js";

/**
 * Regression coverage for a real bug caught during manual verification: an
 * `EmbeddingProviderError` (e.g. OpenAI returning 429 insufficient_quota)
 * had no case in `userFacingMessageFor`, so it fell through to the generic
 * "failed unexpectedly" fallback — losing the one piece of information
 * (check your OpenAI billing/quota) the user actually needed. Every error
 * type this pipeline can throw should map to a message that's more useful
 * than the generic fallback.
 */
describe("userFacingMessageFor (embedding pipeline)", () => {
  it("gives a specific, actionable message for an EmbeddingProviderError", () => {
    const message = userFacingMessageFor(new EmbeddingProviderError("OpenAI embeddings request failed after 3 retries", true));
    expect(message).not.toBe("Semantic indexing failed unexpectedly");
    expect(message).toMatch(/OPENAI_API_KEY|quota|billing/i);
  });

  it("gives the same actionable message regardless of whether the underlying error looked retryable", () => {
    const retryable = userFacingMessageFor(new EmbeddingProviderError("rate limited", true));
    const nonRetryable = userFacingMessageFor(new EmbeddingProviderError("invalid api key", false));
    expect(retryable).toBe(nonRetryable);
  });

  it("still gives the not-configured message for EmbeddingNotConfiguredError", () => {
    expect(userFacingMessageFor(new EmbeddingNotConfiguredError())).toMatch(/OPENAI_API_KEY/);
  });

  it("still gives the GitHub-specific messages", () => {
    expect(userFacingMessageFor(new GitHubArchiveError("boom", 401))).toMatch(/GitHub connection is invalid/);
    expect(userFacingMessageFor(new GitHubArchiveError("boom", 404))).toMatch(/not found on GitHub/);
  });

  it("still gives the extraction-limit and unsafe-path messages", () => {
    expect(userFacingMessageFor(new ExtractionLimitError("repository_too_large"))).toMatch(/exceeds the configured size limit/);
    expect(userFacingMessageFor(new UnsafeArchivePathError("../evil"))).toMatch(/unsafe file path/);
  });

  it("falls back to a generic message only for a genuinely unrecognized error", () => {
    expect(userFacingMessageFor(new Error("something else entirely"))).toBe("Semantic indexing failed unexpectedly");
  });
});
