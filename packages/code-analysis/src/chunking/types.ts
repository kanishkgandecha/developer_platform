/**
 * Framework-independent input/output shapes for the chunking engine — same
 * dependency-free constraint as ../analysis/types.ts (no Postgres, no
 * Prisma, no BullMQ import anywhere in this directory). The caller
 * (apps/worker/src/embedding) is responsible for turning Prisma rows into
 * these shapes and the chunker's output back into `CodeChunk` rows.
 */

/**
 * The subset of a CodeSymbol row the chunker needs to find semantic
 * boundaries. Deliberately not `CodeSymbolDto`/Prisma's `CodeSymbol` —
 * this module never imports either, so it stays usable standalone (and
 * trivially testable without a database).
 */
export interface ChunkableSymbol {
  id: string;
  name: string;
  kind: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** `null` for a module-level (top-level) symbol. */
  parentId: string | null;
}

export interface ChunkInput {
  /** Relative path, matching RepositoryFile.path — used only for hashing/logging, chunking itself doesn't care about it. */
  filePath: string;
  language: string;
  /** Full file source, exactly as read from disk. */
  content: string;
  /**
   * Every CodeSymbol Phase 4 found in this file, in any order — the chunker
   * sorts and nests them itself. An empty array is a legitimate input (a
   * file Phase 4 couldn't parse symbols for, or a language it has no parser
   * for at all) and triggers the pure line-based fallback.
   */
  symbols: ChunkableSymbol[];
}

export interface ChunkingConfig {
  /**
   * Preferred chunk size, in characters — not tokens. This is a documented
   * approximation (roughly 4 characters per token for typical source code),
   * not an actual tokenizer; see docs/semantic-search.md's "chunking"
   * section for why no tokenizer dependency was introduced.
   */
  targetChars: number;
  /** Hard ceiling before a region is forcibly sub-split (by nested symbols, then by lines) regardless of semantic boundaries. */
  maxChars: number;
  /** Line overlap between consecutive line-based fallback chunks within the same region — never applied between two different symbols' chunks. */
  overlapLines: number;
  /**
   * A region shorter than this (after trimming whitespace) is dropped
   * rather than becoming its own near-empty chunk — mainly the blank-line
   * gaps between symbols. Not configurable via environment (not worth a
   * dedicated variable) — always 40.
   */
  minChars: number;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetChars: 1600,
  maxChars: 4000,
  overlapLines: 3,
  minChars: 40,
};

export interface CodeChunkCandidate {
  /** Sequential within the file, in source order, starting at 0 — this plus `filePath` is the chunk's stable identity across re-embeds (see CodeChunk's `@@unique([fileId, chunkIndex])`). */
  chunkIndex: number;
  content: string;
  /** SHA-256 hex digest over `${filePath}::${chunkIndex}::${content}`. */
  contentHash: string;
  startLine: number;
  endLine: number;
  /** The enclosing (or exactly-matching) symbol's id, if this chunk corresponds to one — `null` for fallback/gap chunks. */
  symbolId: string | null;
  symbolName: string | null;
  language: string;
  charCount: number;
}
