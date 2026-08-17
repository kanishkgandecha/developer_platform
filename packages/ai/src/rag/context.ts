import type { RetrievalResultDto } from "@developer-platform/shared";
import type { RagContext, RagContextBudget, RagContextChunk } from "./types.js";
import { DEFAULT_RAG_CONTEXT_BUDGET } from "./types.js";

function citationFor(result: RetrievalResultDto): string {
  if (result.startLine !== null && result.endLine !== null) {
    return result.startLine === result.endLine
      ? `${result.filePath}:${result.startLine}`
      : `${result.filePath}:${result.startLine}-${result.endLine}`;
  }
  return result.filePath;
}

/**
 * Assembles a deterministic, budget-bounded RAG context from already-ranked
 * retrieval results. Pure context assembly — no LLM call anywhere in this
 * function or this package; Phase 5 is the retrieval layer, Phase 6's
 * agents are the ones that will eventually send a RagContext to a model.
 *
 * Trusts the input order (assumes `results` is already sorted by
 * `finalScore` descending, which is what apps/api/src/services/search.ts
 * produces) rather than re-sorting — a caller with a deliberately different
 * order (e.g. a future re-ranking step) is respected, not silently undone.
 *
 * Never splits a chunk's `content` to make it fit the budget — a chunk
 * either fits whole or is left out entirely (and skipping doesn't stop the
 * scan: a smaller, lower-ranked chunk after an oversized one can still fit
 * and gets included), preserving the chunking engine's "one chunk = one
 * coherent citable unit" guarantee all the way through to the model.
 */
export function buildRagContext(
  results: readonly RetrievalResultDto[],
  budget: Partial<RagContextBudget> = {},
): RagContext {
  const resolvedBudget: RagContextBudget = { ...DEFAULT_RAG_CONTEXT_BUDGET, ...budget };
  const chunks: RagContextChunk[] = [];
  let totalCharacters = 0;
  let truncated = 0;

  for (const result of results) {
    const wouldExceedCount = chunks.length >= resolvedBudget.maxResults;
    const wouldExceedChars = totalCharacters + result.content.length > resolvedBudget.maxCharacters;
    if (wouldExceedCount || wouldExceedChars) {
      truncated += 1;
      continue;
    }

    chunks.push({
      chunkId: result.chunkId,
      filePath: result.filePath,
      symbolName: result.symbolName,
      startLine: result.startLine,
      endLine: result.endLine,
      content: result.content,
      score: result.finalScore,
      citation: citationFor(result),
    });
    totalCharacters += result.content.length;
  }

  return { chunks, totalCharacters, truncated };
}
