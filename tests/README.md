# tests/

Reserved for cross-app end-to-end tests (Playwright), covering the full flow described in
[docs/architecture.md](../docs/architecture.md): sign in → connect repository → start analysis →
watch progress → explore findings → ask a question. Not populated in Phase 1 — there's no user flow
to test end-to-end yet. Unit and integration tests for what exists today live next to their source
in each app/package (`apps/*/test/`, `packages/*/src/*.test.ts`).
