/**
 * Shared shape for the API's /health response, consumed by apps/web's /status
 * page so both sides agree on the contract without duplicating a type.
 */
export interface HealthStatus {
  status: "ok" | "degraded";
  environment: string;
  timestamp: string;
  checks: {
    database: "ok" | "error";
    redis: "ok" | "error";
    /**
     * Whether the worker process has written a recent heartbeat to Redis
     * (see apps/worker/src/heartbeat.ts) — a real liveness signal, not
     * inferred from the API's own health.
     */
    worker: "ok" | "error";
    /**
     * Whether real (non-placeholder) GitHub OAuth App credentials are
     * configured — not whether any particular user is signed in. Never
     * includes the credential values themselves.
     */
    githubOAuth: "configured" | "not_configured";
  };
}
