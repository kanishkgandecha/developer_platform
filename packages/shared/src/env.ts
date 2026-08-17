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
});

/**
 * Variables reserved for functionality landing in later phases (OpenAI-backed
 * agents). Their names are locked in now so downstream phases don't need to
 * rename anything, but nothing reads their values yet.
 */
const futurePhaseSchema = z.object({
  OPENAI_API_KEY: z.string().optional(),
});

export const envSchema = requiredSchema.merge(futurePhaseSchema);

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
