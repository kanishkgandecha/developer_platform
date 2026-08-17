import OpenAI, { APIError } from "openai";
import { zodResponseFormat } from "openai/helpers/zod";
import type { AIProvider, StructuredRequest } from "./types.js";
import { AIProviderError } from "./types.js";

/**
 * The narrow slice of the OpenAI SDK this provider actually calls — same
 * dependency-injection seam as OpenAIEmbeddingsClient
 * (packages/ai/src/embedding/openai-provider.ts): unit tests supply a fake
 * client instead of hitting the real OpenAI API. `response_format` is typed
 * `unknown` here deliberately — this interface only describes what *we*
 * call with, not the real SDK's full (and much more specific) parameter
 * type; `zodResponseFormat(...)`'s return value is always assignable to it.
 */
export interface AIChatClient {
  chat: {
    completions: {
      create(params: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
        response_format: unknown;
        temperature?: number;
      }): Promise<{ choices: { message: { content: string | null } }[]; model: string }>;
    };
  };
}

export interface OpenAIChatProviderOptions {
  apiKey: string;
  model: string;
  maxRetries?: number;
  /** Test-only injection point — see AIChatClient's doc comment. Production callers never set this. */
  client?: AIChatClient;
  /** Test-only override so retry tests don't wait on real multi-second sleeps. */
  retryDelayMs?: number;
}

const DEFAULT_MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const DEFAULT_TEMPERATURE = 0.2;

function isRetryableError(error: unknown): boolean {
  if (error instanceof APIError) {
    // 429 (rate limit) and 5xx are transient; 400/401/403/404/422 are not.
    return error.status === 429 || (typeof error.status === "number" && error.status >= 500);
  }
  // Anything without an HTTP status (connection error, timeout) is treated
  // as transient — same reasoning as the embedding provider's identical check.
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The default, real AIProvider implementation. Uses `chat.completions.create`
 * with `response_format: zodResponseFormat(schema, schemaName)` — this
 * constrains the model's raw JSON output server-side, but (deliberately,
 * for full control over validation and testability) this provider does its
 * *own* `JSON.parse` + `schema.safeParse` on the response rather than
 * relying on the SDK's `.parse()` auto-parsing convenience method. A
 * malformed JSON body or a schema-invalid (but syntactically valid) JSON
 * body both count as a retryable failure — see `generateStructured`'s bounded
 * retry loop, which retries the *whole request* (a fresh model call), not
 * just the parse step, since the model may simply produce a better response
 * on a second attempt.
 */
export function createOpenAIChatProvider(options: OpenAIChatProviderOptions): AIProvider {
  // The real OpenAI client's `create` overloads are typed far more
  // specifically than this file's own narrow `AIChatClient` interface
  // needs (see that interface's doc comment on `response_format`) — the
  // cast is safe because every call site here only ever passes values the
  // real SDK actually accepts.
  const client: AIChatClient = options.client ?? (new OpenAI({ apiKey: options.apiKey }) as unknown as AIChatClient);
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? BASE_RETRY_DELAY_MS;

  async function attempt<T>(request: StructuredRequest<T>, attemptNumber: number): Promise<T> {
    const requestMaxRetries = request.maxRetries ?? maxRetries;

    let raw: string | null;
    try {
      const completion = await client.chat.completions.create({
        model: options.model,
        messages: [
          { role: "system", content: request.systemPrompt },
          { role: "user", content: request.userPrompt },
        ],
        response_format: zodResponseFormat(request.schema, request.schemaName),
        temperature: request.temperature ?? DEFAULT_TEMPERATURE,
      });
      raw = completion.choices[0]?.message?.content ?? null;
    } catch (error) {
      return retryOrThrow(request, attemptNumber, requestMaxRetries, isRetryableError(error), "OpenAI chat completion request failed", error);
    }

    if (!raw) {
      return retryOrThrow(request, attemptNumber, requestMaxRetries, true, "OpenAI returned an empty response", undefined);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      return retryOrThrow(request, attemptNumber, requestMaxRetries, true, "OpenAI returned a response that was not valid JSON", error);
    }

    const validated = request.schema.safeParse(parsedJson);
    if (!validated.success) {
      return retryOrThrow(
        request,
        attemptNumber,
        requestMaxRetries,
        true,
        `OpenAI returned a response that did not match the required schema: ${validated.error.message}`,
        validated.error,
      );
    }

    return validated.data;
  }

  async function retryOrThrow<T>(
    request: StructuredRequest<T>,
    attemptNumber: number,
    requestMaxRetries: number,
    retryable: boolean,
    message: string,
    cause: unknown,
  ): Promise<T> {
    if (retryable && attemptNumber <= requestMaxRetries) {
      await sleep(retryDelayMs * 2 ** (attemptNumber - 1));
      return attempt(request, attemptNumber + 1);
    }
    throw new AIProviderError(
      retryable ? `${message} (gave up after ${requestMaxRetries} retries)` : message,
      retryable,
      cause,
    );
  }

  return {
    provider: "openai",
    model: options.model,
    generateStructured<T>(request: StructuredRequest<T>): Promise<T> {
      return attempt(request, 1);
    },
  };
}
