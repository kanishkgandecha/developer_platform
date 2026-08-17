import type { EmbeddingProvider } from "./types.js";
import { createOpenAIEmbeddingProvider } from "./openai-provider.js";

/**
 * Structural, not `@developer-platform/shared`'s full `Env` — this package
 * stays independent of the shared env schema's other, unrelated fields
 * (GitHub OAuth, session secrets, ...); it only needs to know these four
 * exist. `Env` satisfies this without a cast.
 */
export interface EmbeddingEnv {
  // `| undefined`, not just `?:` — matches the shape zod's `.optional()`
  // actually infers on packages/shared's Env, which exactOptionalPropertyTypes
  // treats as a distinct type from a merely-absent key.
  OPENAI_API_KEY?: string | undefined;
  EMBEDDING_MODEL: string;
  EMBEDDING_DIMENSIONS: number;
  EMBEDDING_BATCH_SIZE: number;
}

/**
 * The one place "is the embedding feature configured at all?" is decided —
 * both apps/worker's embedding pipeline and apps/api's search route call
 * this instead of each re-implementing the `OPENAI_API_KEY` presence check.
 * Returns `null` (never throws) when it isn't configured — see
 * packages/shared/src/env.ts's `OPENAI_API_KEY` doc comment and
 * docs/semantic-search.md's "no API key" section for why this must be a
 * graceful "not configured" outcome, not a boot-time failure.
 */
export function createEmbeddingProviderFromEnv(env: EmbeddingEnv): EmbeddingProvider | null {
  if (!env.OPENAI_API_KEY) return null;
  return createOpenAIEmbeddingProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.EMBEDDING_MODEL,
    dimensions: env.EMBEDDING_DIMENSIONS,
    batchSize: env.EMBEDDING_BATCH_SIZE,
  });
}
