import { createEmbeddingProviderFromEnv, type EmbeddingProvider } from "@developer-platform/ai";
import { env } from "../env.js";

/**
 * Thin wrapper around `createEmbeddingProviderFromEnv` — exists as its own
 * module purely as a test seam (see apps/api/test/embeddings.test.ts, which
 * `vi.mock`s this the same way apps/api/test/analyses.test.ts mocks
 * ../src/queue.js) so route tests can inject a deterministic mock provider
 * without ever needing a real `OPENAI_API_KEY` or hitting the network.
 */
export function getEmbeddingProvider(): EmbeddingProvider | null {
  return createEmbeddingProviderFromEnv(env);
}
