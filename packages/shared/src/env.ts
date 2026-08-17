import { z } from "zod";

/**
 * Environment variables required for the platform to boot at all.
 * Nothing here is optional for local/dev/prod — if one of these is missing the
 * process should fail fast with a clear error rather than limp along.
 *
 * Phase 2 note on GITHUB_CLIENT_ID/GITHUB_CLIENT_SECRET: these are required
 * (not just present-but-unused) because authentication is now core
 * functionality, not a future phase placeholder. They still don't need to be
 * *real* GitHub OAuth App credentials just to boot the stack — see
 * .env.example, which ships syntactically-valid local-dev placeholders so
 * `docker compose up` works out of the box. The `/auth/github` route itself
 * additionally checks whether they look like real GitHub credentials and
 * returns a clear error rather than attempting a doomed OAuth exchange.
 */
const requiredSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url({ message: "DATABASE_URL must be a valid postgres:// URL" }),
  REDIS_URL: z.string().url({ message: "REDIS_URL must be a valid redis:// URL" }),
  SESSION_SECRET: z
    .string()
    .min(32, "SESSION_SECRET must be at least 32 characters long"),

  // GitHub OAuth (Phase 2).
  GITHUB_CLIENT_ID: z.string().min(1, "GITHUB_CLIENT_ID is required"),
  GITHUB_CLIENT_SECRET: z.string().min(1, "GITHUB_CLIENT_SECRET is required"),

  // AES-256-GCM key used to encrypt GitHub access tokens at rest. Must be
  // exactly 32 bytes, base64-encoded. Generate with:
  //   openssl rand -base64 32
  GITHUB_TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine(
      (value) => {
        try {
          return Buffer.from(value, "base64").length === 32;
        } catch {
          return false;
        }
      },
      { message: "GITHUB_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key" },
    ),

  // Where the browser lives — used to build the post-login redirect target
  // and as the CORS-allowed origin. Never derived from request headers.
  WEB_URL: z.string().url({ message: "WEB_URL must be a valid URL, e.g. http://localhost:3000" }),

  // The API's own externally-reachable base URL — used to build the GitHub
  // OAuth callback URL. Must exactly match what's registered in the GitHub
  // OAuth App's "Authorization callback URL".
  API_PUBLIC_URL: z
    .string()
    .url({ message: "API_PUBLIC_URL must be a valid URL, e.g. http://localhost:4000" }),

  // Repository ingestion (Phase 3) — read by apps/worker; apps/api validates
  // the same schema for consistency but doesn't touch the filesystem itself.
  // Relative paths resolve against the process's cwd, which is `/app`
  // inside the worker's Docker image (so the default becomes `/app/workspaces`
  // there) and `apps/worker` for local `pnpm dev` — no per-environment
  // override needed. See docs/repository-ingestion.md.
  INGESTION_WORKSPACE_DIR: z.string().min(1).default("./workspaces"),
  MAX_REPOSITORY_SIZE_MB: z.coerce.number().int().positive().default(500),
  MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),
  MAX_FILES_PER_REPOSITORY: z.coerce.number().int().positive().default(5000),

  // Semantic search / RAG foundation (Phase 5) — read by apps/worker (chunking
  // + embedding pipeline) and apps/api (query embedding for search); both
  // validate the same schema for consistency, same pattern as the Phase 3
  // ingestion limits above. All have sensible defaults — only set these to
  // override them. See docs/semantic-search.md.
  //
  // The embedding model name — also determines the pgvector column's fixed
  // dimension (EMBEDDING_DIMENSIONS below), so changing this without a new
  // migration will not silently "just work" — see docs/semantic-search.md's
  // "changing the embedding model" section.
  EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  // text-embedding-3-small's native output size. Not derived from the model
  // name at runtime (OpenAI doesn't expose it via an API call) — asserted
  // here and cross-checked against the `vector(1536)` column width the
  // migration hard-codes; deliberately not configurable independently of
  // EMBEDDING_MODEL.
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  // Deterministic chunking boundaries — see packages/code-analysis/src/chunking.
  // Character counts, not tokens (documented approximation, no tokenizer
  // dependency — see docs/semantic-search.md).
  CHUNK_TARGET_CHARS: z.coerce.number().int().positive().default(1600),
  CHUNK_MAX_CHARS: z.coerce.number().int().positive().default(4000),
  CHUNK_OVERLAP_LINES: z.coerce.number().int().nonnegative().default(3),
  // How many chunk texts go into a single OpenAI embeddings.create call.
  // OpenAI accepts up to 2048 inputs per request; 96 is a conservative
  // default chosen to keep any one request's total token count comfortably
  // under the per-request token ceiling for typical code-chunk sizes rather
  // than blindly maxing out the input-count limit — see
  // docs/semantic-search.md's batching section.
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(96),

  // AI code analysis agents (Phase 6) — read by apps/worker (agent
  // orchestration) and apps/api (the "is AI configured?" checks before
  // enqueuing a job). All have sensible defaults — only set these to
  // override them. See docs/ai-analysis.md.
  //
  // A cost-effective, structured-output-capable chat model — not the
  // cheapest possible option, not the largest; a reasonable default for
  // seven bounded-context analysis calls per repository. Configurable
  // independently of EMBEDDING_MODEL (a completions model, not an
  // embeddings model — no fixed-width database column depends on it, so
  // changing this needs no migration, unlike EMBEDDING_MODEL).
  OPENAI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  // Bounded concurrency for the six primary agents — see
  // docs/ai-analysis.md's "execution order" section for why this exists
  // (never unlimited parallel OpenAI requests).
  AI_AGENT_CONCURRENCY: z.coerce.number().int().positive().max(10).default(3),
  // Bounded retry count for a single agent's structured-output call —
  // covers both transient provider errors and a schema-invalid response;
  // never unbounded.
  AI_AGENT_MAX_RETRIES: z.coerce.number().int().nonnegative().max(5).default(2),

  // Phase 7 (V1 hardening) — read by apps/api. How long a run can sit in an
  // active (PENDING/QUEUED/RUNNING-equivalent) status with no progress
  // before it's treated as orphaned rather than "still legitimately
  // running," letting a new attempt reuse the row instead of permanently
  // blocking with 409. See packages/shared/src/job-staleness.ts.
  STALE_ACTIVE_RUN_MINUTES: z.coerce.number().int().positive().default(30),
});

/**
 * OpenAI API key — powers both the embedding provider (Phase 5) and the
 * chat/completions provider the seven AI agents use (Phase 6), the same key
 * for both. Deliberately optional — the rest of the platform must boot and
 * run without it; only the embedding/search and AI-analysis features report
 * "not configured" (503) when it's missing. See docs/semantic-search.md's
 * and docs/ai-analysis.md's "no API key" sections.
 */
const optionalSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
});

export const envSchema = requiredSchema.merge(optionalSchema);

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates `process.env`. Throws a single, readable error listing
 * every problem at once instead of failing on the first missing variable.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration. Check your .env file against .env.example:\n${issues}`,
    );
  }

  return result.data;
}
