-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'QUEUED', 'PARSING', 'INDEXING', 'ANALYZING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SymbolKind" AS ENUM ('FUNCTION', 'METHOD', 'CLASS', 'INTERFACE', 'TYPE', 'ENUM', 'VARIABLE', 'CONSTANT', 'MODULE');

-- CreateEnum
CREATE TYPE "ImportKind" AS ENUM ('IMPORT', 'REQUIRE', 'DYNAMIC_IMPORT', 'INCLUDE');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateTable
CREATE TABLE "analysis_run" (
    "id" TEXT NOT NULL,
    "ingestionId" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "filesAnalyzed" INTEGER,
    "symbolsFound" INTEGER,
    "importsFound" INTEGER,
    "findingsCount" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analysis_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_symbol" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "SymbolKind" NOT NULL,
    "startLine" INTEGER NOT NULL,
    "endLine" INTEGER NOT NULL,
    "exported" BOOLEAN NOT NULL,
    "signature" TEXT,
    "parentId" TEXT,
    "complexity" INTEGER,
    "parameterCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_symbol_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_import" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "line" INTEGER NOT NULL,
    "resolvedFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_import_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dependency_edge" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "targetFileId" TEXT,
    "external" BOOLEAN NOT NULL,
    "kind" "ImportKind" NOT NULL,
    "specifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dependency_edge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "code_metric" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "codeLineCount" INTEGER NOT NULL,
    "commentLineCount" INTEGER NOT NULL,
    "blankLineCount" INTEGER NOT NULL,
    "functionCount" INTEGER NOT NULL,
    "classCount" INTEGER NOT NULL,
    "importCount" INTEGER NOT NULL,
    "exportCount" INTEGER NOT NULL,
    "complexity" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "code_metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "analysisRunId" TEXT NOT NULL,
    "fileId" TEXT,
    "ruleId" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "message" TEXT NOT NULL,
    "line" INTEGER,
    "column" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "analysis_run_ingestionId_key" ON "analysis_run"("ingestionId");

-- CreateIndex
CREATE INDEX "analysis_run_ingestionId_idx" ON "analysis_run"("ingestionId");

-- CreateIndex
CREATE INDEX "code_symbol_analysisRunId_idx" ON "code_symbol"("analysisRunId");

-- CreateIndex
CREATE INDEX "code_symbol_fileId_idx" ON "code_symbol"("fileId");

-- CreateIndex
CREATE INDEX "code_import_analysisRunId_idx" ON "code_import"("analysisRunId");

-- CreateIndex
CREATE INDEX "code_import_fileId_idx" ON "code_import"("fileId");

-- CreateIndex
CREATE INDEX "dependency_edge_analysisRunId_idx" ON "dependency_edge"("analysisRunId");

-- CreateIndex
CREATE INDEX "dependency_edge_sourceFileId_idx" ON "dependency_edge"("sourceFileId");

-- CreateIndex
CREATE INDEX "code_metric_analysisRunId_idx" ON "code_metric"("analysisRunId");

-- CreateIndex
CREATE UNIQUE INDEX "code_metric_analysisRunId_fileId_key" ON "code_metric"("analysisRunId", "fileId");

-- CreateIndex
CREATE INDEX "finding_analysisRunId_idx" ON "finding"("analysisRunId");

-- CreateIndex
CREATE INDEX "finding_fileId_idx" ON "finding"("fileId");

-- AddForeignKey
ALTER TABLE "analysis_run" ADD CONSTRAINT "analysis_run_ingestionId_fkey" FOREIGN KEY ("ingestionId") REFERENCES "ingestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_symbol" ADD CONSTRAINT "code_symbol_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "code_symbol"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_import" ADD CONSTRAINT "code_import_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_import" ADD CONSTRAINT "code_import_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_import" ADD CONSTRAINT "code_import_resolvedFileId_fkey" FOREIGN KEY ("resolvedFileId") REFERENCES "repository_file"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edge" ADD CONSTRAINT "dependency_edge_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edge" ADD CONSTRAINT "dependency_edge_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dependency_edge" ADD CONSTRAINT "dependency_edge_targetFileId_fkey" FOREIGN KEY ("targetFileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_metric" ADD CONSTRAINT "code_metric_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "code_metric" ADD CONSTRAINT "code_metric_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_analysisRunId_fkey" FOREIGN KEY ("analysisRunId") REFERENCES "analysis_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "repository_file"("id") ON DELETE CASCADE ON UPDATE CASCADE;
