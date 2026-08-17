import type { AIProvider, StructuredRequest } from "./types.js";
import { AIProviderError } from "./types.js";

export interface MockAIChatProviderOptions {
  model?: string;
  /**
   * Produces the (unvalidated) response value for a given request — a
   * function, not a fixed value, so each test controls exactly what its
   * agent "receives" per call (keyed however the test finds convenient,
   * typically by inspecting `request.schemaName` or `request.userPrompt`).
   * Defaults to a responder that always throws, since a test that forgets
   * to supply one should fail loudly, not silently return `{}`.
   */
  responder?: (request: StructuredRequest<unknown>) => unknown;
}

/**
 * Deterministic, network-free `AIProvider` used by every unit/integration
 * test in this codebase — no test in this repository ever makes a real
 * OpenAI network call. Mirrors `createMockEmbeddingProvider`'s role exactly
 * (packages/ai/src/embedding/mock-provider.ts), but for structured chat
 * responses instead of vectors: the caller supplies a `responder`, and this
 * provider still runs the result through the *real* `schema.safeParse` —
 * catching a malformed test fixture the same way a real schema-invalid
 * model response would be caught, never just trusting the responder.
 */
export function createMockAIChatProvider(options: MockAIChatProviderOptions = {}): AIProvider {
  const responder =
    options.responder ??
    (() => {
      throw new Error("createMockAIChatProvider: no responder configured for this request");
    });

  return {
    provider: "mock",
    model: options.model ?? "mock-chat",
    async generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
      const value = responder(request as StructuredRequest<unknown>);
      const validated = request.schema.safeParse(value);
      if (!validated.success) {
        throw new AIProviderError(`mock responder returned data that doesn't match the schema: ${validated.error.message}`, false);
      }
      return validated.data;
    },
  };
}
