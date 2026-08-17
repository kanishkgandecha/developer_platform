import type { ZodType } from "zod";

/**
 * Framework-independent chat/completion provider abstraction — the AI
 * agents (packages/ai/src/agents) depend only on this, never on the OpenAI
 * SDK directly. Mirrors EmbeddingProvider's "one small interface, no
 * plugin registry" shape (packages/ai/src/embedding/types.ts).
 */
export interface StructuredRequest<T> {
  /** Guardrails + agent-specific focus/instructions — see packages/ai/src/agents/guardrails.ts. Never contains repository content. */
  systemPrompt: string;
  /** The actual evidence (deterministic findings + retrieved code) the agent reasons over — always DATA, never treated as instructions by the provider. */
  userPrompt: string;
  schema: ZodType<T>;
  /** A short, stable identifier for the JSON schema sent to the provider (e.g. `"security_agent_output"`) — must match `^[a-zA-Z0-9_-]+$`. */
  schemaName: string;
  /** Overrides the provider's own default retry bound for this one request. */
  maxRetries?: number;
  /** Low by default (see openai-provider.ts) — this is analysis, not creative writing; determinism/consistency matters more than variety. */
  temperature?: number;
}

export interface AIProvider {
  readonly provider: string;
  readonly model: string;
  /**
   * Requests a structured, schema-validated response. Never returns
   * unvalidated data — either resolves with a value that has already passed
   * `schema.safeParse`, or rejects with an `AIProviderError`.
   */
  generateStructured<T>(request: StructuredRequest<T>): Promise<T>;
}

/**
 * Thrown for anything from a transient rate limit to a malformed/schema-
 * invalid response. `retryable` tells the caller whether retrying the same
 * request later is worth attempting — mirrors EmbeddingProviderError's
 * shape and reasoning exactly (packages/ai/src/embedding/types.ts).
 */
export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}
