// Ensures env validation succeeds when test files import modules that read
// `env` at module-init time. Values point at the docker-compose services but
// are never dialed by the pure unit tests in this app — only used so the
// Zod schema in @developer-platform/shared parses successfully.
process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "postgresql://developer_platform:developer_platform@localhost:5432/developer_platform_test";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.SESSION_SECRET ??= "test-session-secret-please-change-0123456789";
process.env.GITHUB_CLIENT_ID ??= "test-github-client-id";
process.env.GITHUB_CLIENT_SECRET ??= "test-github-client-secret";
process.env.GITHUB_TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32, 9).toString("base64");
process.env.WEB_URL ??= "http://localhost:3000";
process.env.API_PUBLIC_URL ??= "http://localhost:4000";
