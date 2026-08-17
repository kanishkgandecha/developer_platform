-- CreateEnum
CREATE TYPE "AIAnalysisStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentType" AS ENUM ('ARCHITECTURE', 'CODE_QUALITY', 'SECURITY', 'PERFORMANCE', 'DEPENDENCY_RISK', 'DOCUMENTATION', 'EXECUTIVE_SUMMARY');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AIFindingSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');

-- Prisma's schema-diffing engine has no way to represent the Phase 5
-- migration's hand-written `USING hnsw (...)` vector index in
-- schema.prisma (there's no schema-language syntax for pgvector's ANN
-- index methods — see that migration's own comment) and therefore reads it
-- as drift, generating a `DROP INDEX "code_chunk_embedding_hnsw_idx";`
-- here. Deliberately removed from this migration — dropping it would
-- silently degrade every future vector query back to a full sequential
-- scan. The index is untouched by anything else in this migration.

-- CreateTable
CREATE TABLE "ai_analysis_run" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "status" "AIAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_analysis_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run" (
    "id" TEXT NOT NULL,
    "aiAnalysisRunId" TEXT NOT NULL,
    "agent" "AgentType" NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "result" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_finding" (
    "id" TEXT NOT NULL,
    "agentRunId" TEXT NOT NULL,
    "aiAnalysisRunId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "severity" "AIFindingSeverity" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "recommendation" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ai_analysis_run_analysisRunId_key" ON "ai_analysis_run"("analysisRunId");

-- CreateIndex
CREATE INDEX "ai_analysis_run_repositoryId_idx" ON "ai_analysis_run"("repositoryId");

-- CreateIndex
CREATE INDEX "agent_run_aiAnalysisRunId_idx" ON "agent_run"("aiAnalysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_aiAnalysisRunId_agent_key" ON "agent_run"("aiAnalysisRunId", "agent");

-- CreateIndex
CREATE INDEX "ai_finding_agentRunId_idx" ON "ai_finding"("agentRunId");

-- CreateIndex
CREATE INDEX "ai_finding_aiAnalysisRunId_idx" ON "ai_finding"("aiAnalysisRunId");

-- CreateIndex
CREATE INDEX "ai_finding_severity_idx" ON "ai_finding"("severity");

-- AddForeignKey
ALTER TABLE "ai_analysis_run" ADD CONSTRAINT "ai_analysis_run_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_analysis_run" ADD CONSTRAINT "ai_analysis_run_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_run" ADD CONSTRAINT "agent_run_aiAnalysisRunId_fkey" FOREIGN KEY ("aiAnalysisRunId") REFERENCES "ai_analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_finding" ADD CONSTRAINT "ai_finding_agentRunId_fkey" FOREIGN KEY ("agentRunId") REFERENCES "agent_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_finding" ADD CONSTRAINT "ai_finding_aiAnalysisRunId_fkey" FOREIGN KEY ("aiAnalysisRunId") REFERENCES "ai_analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
