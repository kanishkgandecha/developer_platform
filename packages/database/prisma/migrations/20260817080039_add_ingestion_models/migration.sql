-- CreateEnum
CREATE TYPE "IngestionStatus" AS ENUM ('PENDING', 'QUEUED', 'RETRIEVING', 'EXTRACTING', 'SCANNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('SOURCE', 'CONFIG', 'DOCUMENTATION', 'DATA', 'BINARY', 'GENERATED', 'IGNORED');

-- CreateTable
CREATE TABLE "ingestion" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "status" "IngestionStatus" NOT NULL DEFAULT 'PENDING',
    "commitSha" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "fileCount" INTEGER,
    "sourceFileCount" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repository_file" (
    "id" TEXT NOT NULL,
    "ingestionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT,
    "language" TEXT,
    "category" "FileCategory" NOT NULL,
    "size" INTEGER NOT NULL,
    "isSource" BOOLEAN NOT NULL,
    "isIgnored" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repository_file_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ingestion_repositoryId_idx" ON "ingestion"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_repositoryId_commitSha_key" ON "ingestion"("repositoryId", "commitSha");

-- CreateIndex
CREATE INDEX "repository_file_ingestionId_idx" ON "repository_file"("ingestionId");

-- CreateIndex
CREATE UNIQUE INDEX "repository_file_ingestionId_path_key" ON "repository_file"("ingestionId", "path");

-- AddForeignKey
ALTER TABLE "ingestion" ADD CONSTRAINT "ingestion_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repository_file" ADD CONSTRAINT "repository_file_ingestionId_fkey" FOREIGN KEY ("ingestionId") REFERENCES "ingestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
