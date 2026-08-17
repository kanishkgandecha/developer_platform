import pino, { type LoggerOptions } from "pino";
import { env } from "./env.js";

const options: LoggerOptions = {
  level: env.NODE_ENV === "production" ? "info" : "debug",
  redact: {
    paths: ["*.password", "*.secret", "*.token", "*.accessToken", "*.apiKey"],
    censor: "[REDACTED]",
  },
};

// `exactOptionalPropertyTypes` treats `transport: undefined` differently from
// omitting the key entirely, so it's added conditionally rather than via a
// ternary that could assign `undefined`.
if (env.NODE_ENV === "development") {
  options.transport = { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } };
}

export const logger = pino(options);
