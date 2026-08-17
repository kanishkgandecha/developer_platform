/**
 * The embedding provider abstraction and RAG context builder — populated
 * starting Phase 5 (semantic search + RAG foundation). No AI agents, no
 * chat, no LLM-generated summaries live here yet; those are Phase 6+. See
 * docs/semantic-search.md and docs/architecture.md.
 */
export * from "./embedding/index.js";
export * from "./rag/index.js";
