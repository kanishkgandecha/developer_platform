-- CreateEnum
CREATE TYPE "EmbeddingRunStatus" AS ENUM ('PENDING', 'QUEUED', 'EMBEDDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "embedding_run" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "status" "EmbeddingRunStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "model" TEXT NOT NULL,
    "dimensions" INTEGER NOT NULL,
    "chunksDiscovered" INTEGER,
    "chunksReused" INTEGER,
    "chunksEmbedded" INTEGER,
    "chunksDeleted" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "embedding_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_chunk" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "embeddingRunId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "startLine" INTEGER,
    "endLine" INTEGER,
    "symbolId" TEXT,
    "symbolName" TEXT,
    "language" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_chunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "embedding_run_analysisRunId_key" ON "embedding_run"("analysisRunId");

-- CreateIndex
CREATE INDEX "embedding_run_repositoryId_idx" ON "embedding_run"("repositoryId");

-- CreateIndex
CREATE INDEX "code_chunk_repositoryId_idx" ON "code_chunk"("repositoryId");

-- CreateIndex
CREATE INDEX "code_chunk_analysisRunId_idx" ON "code_chunk"("analysisRunId");

-- CreateIndex
CREATE INDEX "code_chunk_embeddingRunId_idx" ON "code_chunk"("embeddingRunId");

-- CreateIndex
CREATE INDEX "code_chunk_contentHash_idx" ON "code_chunk"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "code_chunk_fileId_chunkIndex_key" ON "code_chunk"("fileId", "chunkIndex");

-- AddForeignKey
ALTER TABLE "embedding_run" ADD CONSTRAINT "embedding_run_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "embedding_run" ADD CONSTRAINT "embedding_run_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunk" ADD CONSTRAINT "code_chunk_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunk" ADD CONSTRAINT "code_chunk_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunk" ADD CONSTRAINT "code_chunk_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunk" ADD CONSTRAINT "code_chunk_embeddingRunId_fkey" FOREIGN KEY ("embeddingRunId") REFERENCES "embedding_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_chunk" ADD CONSTRAINT "code_chunk_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex (hand-written — Prisma's schema language has no syntax for
-- pgvector's ANN index methods, so this can't be expressed in schema.prisma
-- and generated; it's added directly to this migration instead, same
-- "raw SQL where Prisma's vector support requires it" escape hatch as the
-- `vector(1536)` column type above.)
--
-- HNSW (not IVFFlat): no separate "training" step needed before the index
-- is usable (IVFFlat's list centroids need data present at CREATE INDEX
-- time and degrade for a table that keeps growing/changing, which is
-- exactly this table's shape — embeddings arrive incrementally, run by
-- run). `vector_cosine_ops` matches the distance operator every query in
-- this codebase uses (`<=>`, pgvector's cosine-distance operator) — see
-- apps/api/src/services/search.ts. Only one index on `embedding`: no
-- redundant second index with a different opclass.
--
-- `m`/`ef_construction` are left at pgvector's own defaults (16 / 64) —
-- Phase 5 has no production-scale corpus yet to tune them against; revisit
-- once real query-latency data exists (see docs/semantic-search.md's "known
-- limitations").
CREATE INDEX "code_chunk_embedding_hnsw_idx" ON "code_chunk" USING hnsw ("embedding" vector_cosine_ops);
