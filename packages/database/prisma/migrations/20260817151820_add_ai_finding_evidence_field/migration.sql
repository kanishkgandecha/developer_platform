/*
  Warnings:

  - Added the required column `evidence` to the `ai_finding` table without a default value. This is not possible if the table is not empty.

*/
-- (No DropIndex here — Prisma's diff again proposed dropping
-- "code_chunk_embedding_hnsw_idx" because it can't represent a hand-written
-- pgvector HNSW index in schema.prisma; deliberately omitted, same as the
-- previous migration. See that migration's comment for the full
-- explanation.)

-- AlterTable
ALTER TABLE "ai_finding" ADD COLUMN     "evidence" TEXT NOT NULL;
