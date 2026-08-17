import { prisma, toVectorLiteral } from "@developer-platform/database";
import type { EmbeddingProvider } from "@developer-platform/ai";
import type { RetrievalResultDto } from "@developer-platform/shared";

const SEMANTIC_WEIGHT = 0.75;
const LEXICAL_WEIGHT = 0.25;
/** How many top-semantic candidates to pull before re-ranking with the lexical score — wide enough that a strong lexical match a bit further down the semantic ordering still has a chance to surface, capped so the query stays cheap. */
const CANDIDATE_POOL_MULTIPLIER = 4;
const MAX_CANDIDATE_POOL = 100;
/** Query "words" shorter than this are too generic (or noise) to score lexically on their own — same threshold used implicitly by most identifier-matching tools. */
const MIN_TOKEN_LENGTH = 2;

interface CandidateRow {
  chunkId: string;
  fileId: string;
  filePath: string;
  symbolName: string | null;
  language: string;
  content: string;
  startLine: number | null;
  endLine: number | null;
  semanticScore: number;
}

/**
 * Deterministic lexical score in [0, 1]: the fraction of the query's
 * identifier-like tokens that appear verbatim (case-insensitive) in the
 * chunk's content or symbol name, with an exact symbol-name match pinned
 * high. This is what makes a query like `"PatientDashboard"` reliably
 * surface the file defining `PatientDashboard` even when a semantically
 * "close" but textually unrelated chunk scores nearly as high on cosine
 * similarity alone — see docs/semantic-search.md's "hybrid retrieval"
 * section. Deliberately simple substring matching, not a real
 * tokenizer/stemmer or search-ranking framework.
 *
 * Returns `null` (not `0`) when the query has no scoreable tokens at all
 * (e.g. pure punctuation) — `finalScore` then falls back to semantic score
 * alone, since a lexical score of exactly 0 would otherwise incorrectly
 * penalize every candidate equally for a query lexical matching was never
 * going to help with.
 */
export function lexicalScoreFor(query: string, content: string, symbolName: string | null): number | null {
  const tokens = query
    .split(/[^a-zA-Z0-9_]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
  if (tokens.length === 0) return null;

  const lowerContent = content.toLowerCase();
  const lowerSymbol = symbolName?.toLowerCase() ?? null;

  let matchedTokens = 0;
  let exactSymbolMatch = false;
  for (const token of tokens) {
    const lowerToken = token.toLowerCase();
    if (lowerSymbol === lowerToken) exactSymbolMatch = true;
    if ((lowerSymbol && lowerSymbol.includes(lowerToken)) || lowerContent.includes(lowerToken)) {
      matchedTokens += 1;
    }
  }

  if (matchedTokens === 0) return 0;
  const coverage = matchedTokens / tokens.length;
  return exactSymbolMatch ? Math.max(coverage, 0.95) : coverage;
}

export interface SearchRepositoryParams {
  repositoryId: string;
  query: string;
  limit: number;
  provider: EmbeddingProvider;
}

/**
 * Repository-scoped hybrid retrieval: pgvector cosine similarity for the
 * initial candidate pool, re-ranked by a deterministic semantic+lexical
 * blend. `finalScore = 0.75 * semanticScore + 0.25 * lexicalScore` (or just
 * `semanticScore` when the query had no lexical tokens) — fixed weights,
 * not learned/tunable per request, so results are reproducible. See
 * docs/semantic-search.md.
 *
 * Callers are responsible for repository ownership verification *before*
 * calling this — it trusts `repositoryId` completely and never queries
 * outside it (the one hard security boundary here: every row this returns
 * already has `WHERE "repositoryId" = ...` baked into the SQL, not filtered
 * after the fact).
 */
export async function searchRepository(params: SearchRepositoryParams): Promise<RetrievalResultDto[]> {
  const { repositoryId, query, limit, provider } = params;

  const [queryEmbedding] = await provider.embedDocuments([query]);
  if (!queryEmbedding) {
    throw new Error("Embedding provider returned no vector for the search query");
  }
  const vectorLiteral = toVectorLiteral(queryEmbedding.vector);
  const poolSize = Math.min(limit * CANDIDATE_POOL_MULTIPLIER, MAX_CANDIDATE_POOL);

  const rows = await prisma.$queryRaw<CandidateRow[]>`
    SELECT
      "id" AS "chunkId",
      "fileId",
      "filePath",
      "symbolName",
      "language",
      "content",
      "startLine",
      "endLine",
      1 - ("embedding" <=> ${vectorLiteral}::vector) AS "semanticScore"
    FROM "code_chunk"
    WHERE "repositoryId" = ${repositoryId} AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vectorLiteral}::vector
    LIMIT ${poolSize}
  `;

  const scored = rows.map((row) => {
    const lexicalScore = lexicalScoreFor(query, row.content, row.symbolName);
    const finalScore = lexicalScore === null ? row.semanticScore : SEMANTIC_WEIGHT * row.semanticScore + LEXICAL_WEIGHT * lexicalScore;
    return { ...row, lexicalScore, finalScore };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore || b.semanticScore - a.semanticScore);

  return scored.slice(0, limit).map((row) => ({
    chunkId: row.chunkId,
    fileId: row.fileId,
    filePath: row.filePath,
    symbolName: row.symbolName,
    language: row.language,
    content: row.content,
    startLine: row.startLine,
    endLine: row.endLine,
    semanticScore: row.semanticScore,
    lexicalScore: row.lexicalScore,
    finalScore: row.finalScore,
  }));
}
