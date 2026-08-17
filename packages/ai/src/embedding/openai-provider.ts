import OpenAI, { APIError } from "openai";
import type { EmbeddingProvider, EmbeddingResult } from "./types.js";
import { EmbeddingProviderError } from "./types.js";

/**
 * The narrow slice of the OpenAI SDK this provider actually calls —
 * exists purely as a dependency-injection seam so unit tests can supply a
 * fake client (see openai-provider.test.ts) instead of hitting the real
 * OpenAI API. `OpenAI`'s real client satisfies this structurally, no cast
 * needed at the call site.
 */
export interface OpenAIEmbeddingsClient {
  embeddings: {
    create(params: {
      model: string;
      input: string[];
      dimensions?: number;
    }): Promise<{ data: { index: number; embedding: number[] }[]; model: string }>;
  };
}

export interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  model: string;
  dimensions: number;
  /** Max chunk texts per `embeddings.create` call — see EMBEDDING_BATCH_SIZE in packages/shared/src/env.ts. */
  batchSize: number;
  maxRetries?: number;
  /** Test-only injection point — see OpenAIEmbeddingsClient's doc comment. Production callers never set this. */
  client?: OpenAIEmbeddingsClient;
  /** Base retry backoff, doubled per attempt — test-only override so retry tests don't have to wait on real multi-second sleeps. Defaults to `BASE_RETRY_DELAY_MS`. */
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 500;

function isRetryableError(error: unknown): boolean {
  if (error instanceof APIError) {
    // 429 (rate limit) and 5xx are transient; 400/401/403/404/422 are not
    // — retrying a malformed request or a bad key can't ever succeed.
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }
  // Anything without an HTTP status at all (DNS failure, connection reset,
  // timeout) is treated as transient — the OpenAI SDK throws its own
  // `APIConnectionError`/`APIConnectionTimeoutError` for these, both
  // non-`APIError` subclasses of a common base, so this catches them too.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The default, real EmbeddingProvider implementation — OpenAI's
 * `embeddings.create`, batched, retried with exponential backoff on
 * transient failures, and validated (never silently accepting a
 * malformed/short response as if it were real vectors). See
 * docs/semantic-search.md's "embedding provider" and "batching" sections.
 */
export function createOpenAIEmbeddingProvider(options: OpenAIEmbeddingProviderOptions): EmbeddingProvider {
  const client: OpenAIEmbeddingsClient = options.client ?? new OpenAI({ apiKey: options.apiKey });
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? BASE_RETRY_DELAY_MS;

  async function embedBatchWithRetry(batch: string[], attempt = 1): Promise<EmbeddingResult[]> {
    let response: Awaited<ReturnType<OpenAIEmbeddingsClient["embeddings"]["create"]>>;
    try {
      response = await client.embeddings.create({ model: options.model, input: batch, dimensions: options.dimensions });
    } catch (error) {
      const retryable = isRetryableError(error);
      if (retryable && attempt <= maxRetries) {
        await sleep(retryDelayMs * 2 ** (attempt - 1));
        return embedBatchWithRetry(batch, attempt + 1);
      }
      throw new EmbeddingProviderError(
        retryable
          ? `OpenAI embeddings request failed after ${maxRetries} retries`
          : "OpenAI embeddings request failed",
        retryable,
        error,
      );
    }

    if (!Array.isArray(response.data) || response.data.length !== batch.length) {
      throw new EmbeddingProviderError(
        `OpenAI returned ${response.data?.length ?? 0} embeddings for a batch of ${batch.length} inputs`,
        false,
      );
    }

    // response.data is documented as index-aligned with `input`, but sorted
    // defensively rather than trusted blindly — a malformed/out-of-order
    // response must never get silently zipped with the wrong chunk text.
    const sorted = response.data.slice().sort((a, b) => a.index - b.index);
    return sorted.map((item, position) => {
      if (item.index !== position || !Array.isArray(item.embedding) || item.embedding.length !== options.dimensions) {
        throw new EmbeddingProviderError(
          `OpenAI returned a malformed embedding response (index/dimension mismatch at position ${position})`,
          false,
        );
      }
      return { vector: item.embedding, model: response.model, dimensions: item.embedding.length };
    });
  }

  return {
    model: options.model,
    dimensions: options.dimensions,
    async embedDocuments(texts: string[]): Promise<EmbeddingResult[]> {
      if (texts.length === 0) return [];

      const results: EmbeddingResult[] = [];
      for (let start = 0; start < texts.length; start += options.batchSize) {
        const batch = texts.slice(start, start + options.batchSize);
        results.push(...(await embedBatchWithRetry(batch)));
      }
      return results;
    },
  };
}
