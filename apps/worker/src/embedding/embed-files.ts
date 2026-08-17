import { chunkFile } from "@developer-platform/code-analysis";
import type { ChunkableSymbol, ChunkingConfig, CodeChunkCandidate } from "@developer-platform/code-analysis";
import { prisma, toVectorLiteral } from "@developer-platform/database";
import type { EmbeddingProvider } from "@developer-platform/ai";

export interface EmbeddingFileInput {
  fileId: string;
  path: string;
  language: string;
  content: string;
}

export interface EmbeddingStats {
  /** Every chunk candidate the chunker produced this run, before any reuse/embed decision. */
  chunksDiscovered: number;
  /** Content hash matched an existing chunk for the same (fileId, chunkIndex) — no embedding API call made. */
  chunksReused: number;
  /** Actually sent to the embedding provider (new or content-changed). */
  chunksEmbedded: number;
  /** Existing chunks for this embedding run whose (fileId, chunkIndex) no longer appears in the current candidates — removed. */
  chunksDeleted: number;
}

export interface EmbedFilesParams {
  repositoryId: string;
  analysisRunId: string;
  embeddingRunId: string;
  files: EmbeddingFileInput[];
  /** CodeSymbol rows for each file, keyed by fileId — see apps/worker/src/embedding/pipeline.ts for how these are loaded. */
  symbolsByFileId: Map<string, ChunkableSymbol[]>;
  provider: EmbeddingProvider;
  chunkingConfig?: Partial<ChunkingConfig>;
  /** How many chunk texts to send to the provider per `embedDocuments` call — also the granularity `onBatchEmbedded` reports at. */
  batchSize: number;
  /**
   * Called once the diff against existing chunks is known and stale rows
   * are already deleted — *before* any embedding API call is made, so the
   * caller can persist `chunksDiscovered`/`chunksReused`/`chunksDeleted`
   * immediately and give the progress UI a real denominator from the start
   * (see docs/semantic-search.md).
   */
  onDiffComputed?: (stats: Omit<EmbeddingStats, "chunksEmbedded"> & { chunksToEmbed: number }) => Promise<void>;
  /**
   * Called after each batch's vectors are embedded *and durably persisted*
   * — never before persistence, so a crash between two batches leaves
   * `EmbeddingRun.chunksEmbedded` matching exactly what's actually in
   * Postgres, not an optimistic count. This is what backs the "N / total
   * chunks" progress bar (see docs/semantic-search.md).
   */
  onBatchEmbedded?: (count: number) => Promise<void>;
}

interface PendingChunk {
  fileId: string;
  filePath: string;
  language: string;
  candidate: CodeChunkCandidate;
}

function chunkKey(fileId: string, chunkIndex: number): string {
  return `${fileId}::${chunkIndex}`;
}

async function upsertChunk(params: {
  repositoryId: string;
  analysisRunId: string;
  embeddingRunId: string;
  fileId: string;
  filePath: string;
  language: string;
  candidate: CodeChunkCandidate;
  vector: number[];
}): Promise<void> {
  const vectorLiteral = toVectorLiteral(params.vector);
  // A single INSERT ... ON CONFLICT DO UPDATE, keyed on the same
  // `@@unique([fileId, chunkIndex])` the schema declares — this is what
  // makes "reuse the same row across re-embeds" atomic and race-free rather
  // than a separate exists-check-then-write. `id` is only used on the
  // INSERT branch; an existing row keeps its own id.
  await prisma.$executeRaw`
    INSERT INTO "code_chunk" (
      "id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath",
      "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName",
      "language", "charCount", "embedding", "createdAt", "updatedAt"
    ) VALUES (
      gen_random_uuid()::text, ${params.repositoryId}, ${params.fileId}, ${params.analysisRunId}, ${params.embeddingRunId}, ${params.filePath},
      ${params.candidate.chunkIndex}, ${params.candidate.content}, ${params.candidate.contentHash},
      ${params.candidate.startLine}, ${params.candidate.endLine}, ${params.candidate.symbolId}, ${params.candidate.symbolName},
      ${params.language}, ${params.candidate.charCount}, ${vectorLiteral}::vector, now(), now()
    )
    ON CONFLICT ("fileId", "chunkIndex") DO UPDATE SET
      "repositoryId" = EXCLUDED."repositoryId",
      "analysisRunId" = EXCLUDED."analysisRunId",
      "embeddingRunId" = EXCLUDED."embeddingRunId",
      "filePath" = EXCLUDED."filePath",
      "content" = EXCLUDED."content",
      "contentHash" = EXCLUDED."contentHash",
      "startLine" = EXCLUDED."startLine",
      "endLine" = EXCLUDED."endLine",
      "symbolId" = EXCLUDED."symbolId",
      "symbolName" = EXCLUDED."symbolName",
      "language" = EXCLUDED."language",
      "charCount" = EXCLUDED."charCount",
      "embedding" = EXCLUDED."embedding",
      "updatedAt" = now()
  `;
}

/**
 * The testable core of the embedding pipeline: given already-read file
 * contents (apps/worker/src/embedding/pipeline.ts is the only thing that
 * actually downloads a repository archive — this function never touches
 * the filesystem or GitHub), chunks every file, diffs against what's
 * already persisted for this embedding run, embeds only what's new or
 * changed, and removes what's gone. See docs/semantic-search.md's
 * "incremental embedding" section for exactly what "incremental" does and
 * does not cover.
 *
 * Reuse is scoped to `(fileId, chunkIndex)` pairs that already exist for
 * this `embeddingRunId` — i.e. re-running embedding for the *same*
 * ingestion (RepositoryFile rows, and therefore fileIds, unchanged). A new
 * ingestion (new commit) gets new RepositoryFile rows and therefore
 * re-embeds even byte-identical files — a documented, deliberate scope
 * boundary, not an oversight (see docs/semantic-search.md's "known
 * limitations").
 */
export async function embedFilesForRun(params: EmbedFilesParams): Promise<EmbeddingStats> {
  const { repositoryId, analysisRunId, embeddingRunId, files, symbolsByFileId, provider, chunkingConfig, batchSize } = params;

  const pending: PendingChunk[] = [];
  for (const file of files) {
    const symbols = symbolsByFileId.get(file.fileId) ?? [];
    const candidates = chunkFile({ filePath: file.path, language: file.language, content: file.content, symbols }, chunkingConfig);
    for (const candidate of candidates) {
      pending.push({ fileId: file.fileId, filePath: file.path, language: file.language, candidate });
    }
  }
  const chunksDiscovered = pending.length;

  // Every chunk this embedding run currently owns — not filtered to this
  // run's `files` list, deliberately, so a file that's disappeared entirely
  // (deleted, renamed) still has its stale chunks found and removed below.
  const existing = await prisma.codeChunk.findMany({
    where: { embeddingRunId },
    select: { id: true, fileId: true, chunkIndex: true, contentHash: true },
  });
  const existingByKey = new Map(existing.map((row) => [chunkKey(row.fileId, row.chunkIndex), row]));

  const toEmbed: PendingChunk[] = [];
  const toRefresh: { id: string; symbolId: string | null }[] = [];
  const seenKeys = new Set<string>();

  for (const item of pending) {
    const key = chunkKey(item.fileId, item.candidate.chunkIndex);
    seenKeys.add(key);
    const existingRow = existingByKey.get(key);
    if (existingRow && existingRow.contentHash === item.candidate.contentHash) {
      // Reused: no embedding API call. Still refresh `symbolId` — a
      // re-analysis retry deletes and recreates CodeSymbol rows with new
      // ids (see apps/api/src/routes/analyses.ts), which would otherwise
      // SetNull this chunk's symbolId even though its content, and the
      // symbol it belongs to, are unchanged.
      toRefresh.push({ id: existingRow.id, symbolId: item.candidate.symbolId });
    } else {
      toEmbed.push(item);
    }
  }
  const chunksReused = pending.length - toEmbed.length;

  const staleIds = existing.filter((row) => !seenKeys.has(chunkKey(row.fileId, row.chunkIndex))).map((row) => row.id);
  if (staleIds.length > 0) {
    await prisma.codeChunk.deleteMany({ where: { id: { in: staleIds } } });
  }

  if (params.onDiffComputed) {
    await params.onDiffComputed({
      chunksDiscovered,
      chunksReused,
      chunksDeleted: staleIds.length,
      chunksToEmbed: toEmbed.length,
    });
  }

  if (toRefresh.length > 0) {
    await Promise.all(
      toRefresh.map((row) => prisma.codeChunk.update({ where: { id: row.id }, data: { symbolId: row.symbolId } })),
    );
  }

  let chunksEmbedded = 0;
  for (let start = 0; start < toEmbed.length; start += batchSize) {
    const batch = toEmbed.slice(start, start + batchSize);
    const embeddings = await provider.embedDocuments(batch.map((item) => item.candidate.content));
    if (embeddings.length !== batch.length) {
      throw new Error(`Embedding provider returned ${embeddings.length} vectors for a batch of ${batch.length} chunks`);
    }

    await Promise.all(
      batch.map((item, index) =>
        upsertChunk({
          repositoryId,
          analysisRunId,
          embeddingRunId,
          fileId: item.fileId,
          filePath: item.filePath,
          language: item.language,
          candidate: item.candidate,
          vector: embeddings[index]!.vector,
        }),
      ),
    );

    chunksEmbedded += batch.length;
    if (params.onBatchEmbedded) {
      await params.onBatchEmbedded(batch.length);
    }
  }

  return { chunksDiscovered, chunksReused, chunksEmbedded, chunksDeleted: staleIds.length };
}
