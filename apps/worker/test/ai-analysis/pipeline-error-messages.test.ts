import { describe, expect, it } from "vitest";
import { AIProviderError, EmbeddingProviderError } from "@developer-platform/ai";
import { AINotConfiguredError, userFacingMessageFor } from "../../src/ai-analysis/pipeline.js";

/**
 * Same regression coverage as embedding/pipeline.test.ts, for the
 * AI-analysis pipeline's own `userFacingMessageFor` — an agent's `AgentRun.error`
 * (and, for a setup-phase failure, the whole run's `AIAnalysisRun.error`)
 * should say *why* the OpenAI request failed, not just "failed unexpectedly".
 */
describe("userFacingMessageFor (AI analysis pipeline)", () => {
  it("gives a specific, actionable message for an AIProviderError (chat completion failure)", () => {
    const message = userFacingMessageFor(new AIProviderError("OpenAI chat completion request failed", true));
    expect(message).not.toBe("AI analysis failed unexpectedly");
    expect(message).toMatch(/OPENAI_API_KEY|quota|billing/i);
  });

  it("gives a specific, actionable message for an EmbeddingProviderError (query-embedding failure)", () => {
    const message = userFacingMessageFor(new EmbeddingProviderError("OpenAI embeddings request failed", true));
    expect(message).not.toBe("AI analysis failed unexpectedly");
    expect(message).toMatch(/OPENAI_API_KEY|quota|billing/i);
  });

  it("still gives the not-configured message for AINotConfiguredError", () => {
    expect(userFacingMessageFor(new AINotConfiguredError())).toMatch(/OPENAI_API_KEY/);
  });

  it("falls back to a generic message only for a genuinely unrecognized error", () => {
    expect(userFacingMessageFor(new Error("something else entirely"))).toBe("AI analysis failed unexpectedly");
  });
});
