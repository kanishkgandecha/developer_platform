export interface RagContextChunk {
  chunkId: string;
  filePath: string;
  symbolName: string | null;
  startLine: number | null;
  endLine: number | null;
  content: string;
  /** The retrieval result's `finalScore`, carried through unchanged. */
  score: number;
  /** Precomputed source citation, e.g. `"src/services/github.ts:90-121"` — every consumer (Phase 6's agents, this package's tests) formats citations identically because they all read this field rather than building the string themselves. */
  citation: string;
}

export interface RagContextBudget {
  /** Hard cap on the number of chunks included, independent of the character budget below. */
  maxResults: number;
  /** Hard cap on the sum of every included chunk's `content.length`. */
  maxCharacters: number;
}

export const DEFAULT_RAG_CONTEXT_BUDGET: RagContextBudget = {
  maxResults: 10,
  maxCharacters: 12_000,
};

export interface RagContext {
  /** Already in rank order (highest `score` first) — see buildRagContext's doc comment for why it trusts the input order rather than re-sorting. */
  chunks: RagContextChunk[];
  /** Sum of every included chunk's `content.length` — always <= the budget's `maxCharacters`. */
  totalCharacters: number;
  /** How many candidate results were left out by the budget (rank or character cutoff) — not a count of invalid/errored results, there are none of those at this layer. */
  truncated: number;
}
