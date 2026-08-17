import type { LoggerOptions } from "pino";
import { env } from "./env.js";

/**
 * Structured logging config shared by the Fastify instance. Redacts
 * secret-shaped fields so tokens/keys never end up in log output, even by
 * accident in a future route.
 */
export const loggerOptions: LoggerOptions = {
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.password",
      "*.secret",
      "*.token",
      "*.accessToken",
      "*.apiKey",
    ],
    censor: "[REDACTED]",
  },
};

// `exactOptionalPropertyTypes` treats `transport: undefined` differently from
// omitting the key entirely, so it's added conditionally rather than via a
// ternary that could assign `undefined`.
if (env.NODE_ENV === "development") {
  loggerOptions.transport = {
    target: "pino-pretty",
    options: { colorize: true, translateTime: "HH:MM:ss" },
  };
}
