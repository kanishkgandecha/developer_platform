import type { Env } from "@developer-platform/shared";

/**
 * Entry point. Validates the environment first, with a clean error message
 * and non-zero exit on failure, before importing anything that depends on
 * `env` at module-init time (logger, redis, app).
 */
async function main(): Promise<void> {
  let env: Env;
  try {
    ({ env } = await import("./env.js"));
  } catch (error) {
    console.error(
      `\n[api] Failed to start: invalid environment configuration.\n\n${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exit(1);
  }

  const { buildApp } = await import("./app.js");
  const app = buildApp();
  const port = Number(process.env.PORT ?? 4000);

  try {
    await app.listen({ port, host: "0.0.0.0" });
    app.log.info(`API listening on port ${port} (${env.NODE_ENV})`);
  } catch (error) {
    app.log.error({ err: error }, "failed to start API server");
    process.exit(1);
  }

  async function shutdown(signal: string): Promise<void> {
    app.log.info(`received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
