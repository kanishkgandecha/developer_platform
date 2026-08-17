import { createHash } from "node:crypto";
import type { ChunkableSymbol, ChunkInput, ChunkingConfig, CodeChunkCandidate } from "./types.js";
import { DEFAULT_CHUNKING_CONFIG } from "./types.js";

/**
 * A contiguous line range that will become one or more chunks. Either a
 * real symbol's own body (`symbolId` set) or a "gap" between/around symbols
 * — imports, top-of-file comments, module-level statements Phase 4 didn't
 * turn into a symbol (`symbolId: null`).
 */
interface Region {
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  symbolId: string | null;
  symbolName: string | null;
}

/** A region after it's been (possibly further) split down to chunk size, still carrying its resolved source lines. */
interface Piece extends Region {
  lines: string[];
}

/** How many levels of symbol nesting `chunkFile` will use as sub-chunk boundaries (class → method) before giving up and falling back to line-based splitting for whatever's still oversized. Grandchild-level nesting is rare enough in this codebase's symbol model not to warrant unbounded recursion. */
const MAX_NESTING_DEPTH = 2;

function hashChunk(filePath: string, chunkIndex: number, content: string): string {
  return createHash("sha256").update(`${filePath}::${chunkIndex}::${content}`).digest("hex");
}

/**
 * Splits a region's lines into one or more chunks of roughly
 * `config.targetChars`, never exceeding `config.maxChars` per chunk except
 * for the degenerate single-line-longer-than-maxChars case (e.g. minified
 * code) — that line still becomes its own chunk rather than being cut
 * mid-line. Consecutive chunks overlap by `config.overlapLines` lines for
 * continuity; a single chunk that already covers the whole region gets no
 * overlap (nothing to overlap with).
 */
function splitByLines(region: Region, regionLines: string[], config: ChunkingConfig): Piece[] {
  const pieces: Piece[] = [];
  let startIdx = 0;

  while (startIdx < regionLines.length) {
    let endIdx = startIdx;
    let size = 0;
    while (endIdx < regionLines.length) {
      const nextSize = size + (regionLines[endIdx]?.length ?? 0) + 1;
      // Always take at least one line, even if it alone exceeds maxChars —
      // guarantees forward progress and never silently truncates a line.
      if (endIdx > startIdx && nextSize > config.maxChars) break;
      size = nextSize;
      endIdx += 1;
      if (size >= config.targetChars) break;
    }

    pieces.push({
      startLine: region.startLine + startIdx,
      endLine: region.startLine + endIdx - 1,
      symbolId: region.symbolId,
      symbolName: region.symbolName,
      lines: regionLines.slice(startIdx, endIdx),
    });

    if (endIdx >= regionLines.length) break;
    // Overlap the next chunk back by a few lines, but always advance past
    // the current start so a pathological config can't loop forever.
    startIdx = Math.max(endIdx - config.overlapLines, startIdx + 1);
  }

  return pieces;
}

/**
 * Resolves one region into its final chunk pieces. A region that already
 * fits is returned as-is (one piece, maximum semantic coherence — this is
 * the common case for most functions/classes). An oversized region tries
 * its symbol's nested children as sub-boundaries first (e.g. a large
 * class's individual methods); only once nesting is exhausted (no children,
 * or `MAX_NESTING_DEPTH` reached) does it fall back to deterministic
 * line-based splitting.
 */
function emitRegion(
  region: Region,
  allLines: string[],
  childrenByParent: Map<string, ChunkableSymbol[]>,
  config: ChunkingConfig,
  depth: number,
): Piece[] {
  const regionLines = allLines.slice(region.startLine - 1, region.endLine);
  const content = regionLines.join("\n");

  if (content.length <= config.maxChars) {
    return [{ ...region, lines: regionLines }];
  }

  const children = region.symbolId && depth < MAX_NESTING_DEPTH ? childrenByParent.get(region.symbolId) : undefined;

  if (children && children.length > 0) {
    const subRegions: Region[] = [];
    let cursor = region.startLine;
    for (const child of children) {
      if (child.startLine > cursor) {
        subRegions.push({ startLine: cursor, endLine: child.startLine - 1, symbolId: region.symbolId, symbolName: region.symbolName });
      }
      subRegions.push({ startLine: child.startLine, endLine: child.endLine, symbolId: child.id, symbolName: child.name });
      cursor = child.endLine + 1;
    }
    if (cursor <= region.endLine) {
      subRegions.push({ startLine: cursor, endLine: region.endLine, symbolId: region.symbolId, symbolName: region.symbolName });
    }
    return subRegions.flatMap((sub) => emitRegion(sub, allLines, childrenByParent, config, depth + 1));
  }

  return splitByLines(region, regionLines, config);
}

/**
 * Deterministically chunks one file's source into embedding-sized pieces,
 * preferring semantic (symbol) boundaries over blind character splitting —
 * see docs/semantic-search.md's "chunking strategy" section for the full
 * writeup. Pure function: identical input always produces identical output,
 * in the same order, with the same hashes (see CodeChunkCandidate.contentHash) —
 * no randomness, no wall-clock, no I/O.
 *
 * Strategy:
 * 1. Every top-level (`parentId === null`) symbol becomes its own region;
 *    the gaps between/around them (imports, module-level statements Phase 4
 *    didn't symbol-ize) become their own "gap" regions.
 * 2. A region that fits within `maxChars` is one chunk.
 * 3. An oversized region first tries splitting by its own nested symbols
 *    (e.g. a large class → its methods) before falling back to line-based
 *    splitting — see `emitRegion`.
 * 4. A file with no symbols at all (heuristic parser found nothing, or an
 *    unsupported language) is treated as one large gap region, so it still
 *    gets sensible line-based chunks rather than zero chunks.
 * 5. Trivial gap regions (blank lines between symbols, shorter than
 *    `config.minChars` after trimming) are dropped — never embedded as
 *    near-empty, low-signal chunks. A region that *is* an actual symbol is
 *    never dropped this way, however small.
 */
export function chunkFile(input: ChunkInput, configOverrides: Partial<ChunkingConfig> = {}): CodeChunkCandidate[] {
  const config: ChunkingConfig = { ...DEFAULT_CHUNKING_CONFIG, ...configOverrides };

  if (input.content.trim().length === 0) {
    return [];
  }

  const lines = input.content.split("\n");
  const totalLines = lines.length;
  // Whether the trivial-gap filter below applies at all — a file with no
  // symbols becomes one whole-file "gap" region, and that region must never
  // be dropped just for being short (it's the file's only representation),
  // unlike a genuinely trivial gap *between* real symbols in a file that
  // does have them (a blank-line separator, a lone import line).
  const hasAnySymbols = input.symbols.length > 0;

  const topLevel = input.symbols
    .filter((symbol) => symbol.parentId === null)
    .slice()
    .sort((a, b) => a.startLine - b.startLine);

  const childrenByParent = new Map<string, ChunkableSymbol[]>();
  for (const symbol of input.symbols) {
    if (symbol.parentId) {
      const siblings = childrenByParent.get(symbol.parentId) ?? [];
      siblings.push(symbol);
      childrenByParent.set(symbol.parentId, siblings);
    }
  }
  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.startLine - b.startLine);
  }

  const regions: Region[] = [];
  let cursor = 1;
  for (const symbol of topLevel) {
    if (symbol.startLine > cursor) {
      regions.push({ startLine: cursor, endLine: symbol.startLine - 1, symbolId: null, symbolName: null });
    }
    regions.push({ startLine: symbol.startLine, endLine: symbol.endLine, symbolId: symbol.id, symbolName: symbol.name });
    cursor = symbol.endLine + 1;
  }
  if (cursor <= totalLines) {
    regions.push({ startLine: cursor, endLine: totalLines, symbolId: null, symbolName: null });
  }
  // No symbols at all — the whole file is a single fallback region.
  if (regions.length === 0) {
    regions.push({ startLine: 1, endLine: totalLines, symbolId: null, symbolName: null });
  }

  const candidates: CodeChunkCandidate[] = [];
  let chunkIndex = 0;

  for (const region of regions) {
    const pieces = emitRegion(region, lines, childrenByParent, config, 0);
    for (const piece of pieces) {
      const content = piece.lines.join("\n");
      if (piece.symbolId === null && hasAnySymbols && content.trim().length < config.minChars) {
        continue;
      }
      candidates.push({
        chunkIndex,
        content,
        contentHash: hashChunk(input.filePath, chunkIndex, content),
        startLine: piece.startLine,
        endLine: piece.endLine,
        symbolId: piece.symbolId,
        symbolName: piece.symbolName,
        language: input.language,
        charCount: content.length,
      });
      chunkIndex += 1;
    }
  }

  return candidates;
}
