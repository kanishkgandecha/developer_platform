/**
 * Framework-independent embedding provider abstraction — the only contract
 * apps/worker (chunking/embedding pipeline) and apps/api (query embedding
 * for search) depend on. Deliberately one small interface, not a
 * provider/plugin registry — see docs/semantic-search.md's "embedding
 * provider" section for why.
 */
export interface EmbeddingResult {
  vector: number[];
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  /**
   * Embeds a batch of texts, preserving input order in the returned array
   * (`result[i]` corresponds to `texts[i]`). Implementations are
   * responsible for their own request batching against whatever the
   * underlying provider's real limits are — callers may pass an arbitrarily
   * large array.
   */
  embedDocuments(texts: string[]): Promise<EmbeddingResult[]>;
}

/**
 * Thrown by an EmbeddingProvider implementation for anything from a
 * transient rate limit to a malformed response. `retryable` tells the
 * caller (apps/worker's embedding pipeline) whether retrying the same batch
 * later is worth attempting — a 401/malformed-response is not, a 429/5xx
 * is (and the OpenAI implementation already retries those internally with
 * backoff before ever throwing one non-retryable-marked here; see
 * openai-provider.ts).
 */
export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}
