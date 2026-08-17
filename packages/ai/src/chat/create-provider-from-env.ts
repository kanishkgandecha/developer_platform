import type { AIProvider } from "./types.js";
import { createOpenAIChatProvider } from "./openai-provider.js";

/** Structural, same reasoning as embedding/create-provider-from-env.ts's `EmbeddingEnv`. */
export interface AIChatEnv {
  OPENAI_API_KEY?: string | undefined;
  OPENAI_MODEL: string;
  AI_AGENT_MAX_RETRIES: number;
}

/**
 * The one place "is AI analysis configured at all?" is decided — both
 * apps/worker's AI-analysis pipeline and apps/api's route (for the
 * pre-enqueue check) call this instead of each re-implementing the
 * `OPENAI_API_KEY` presence check. Returns `null` (never throws) when
 * unconfigured — see docs/ai-analysis.md's "no API key" section.
 */
export function createAIChatProviderFromEnv(env: AIChatEnv): AIProvider | null {
  if (!env.OPENAI_API_KEY) return null;
  return createOpenAIChatProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL,
    maxRetries: env.AI_AGENT_MAX_RETRIES,
  });
}
