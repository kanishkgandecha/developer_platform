import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createEmbeddingProviderFromEnv } from "@developer-platform/ai";
import type { ChunkableSymbol } from "@developer-platform/code-analysis";
import { prisma } from "@developer-platform/database";
import type { EmbeddingJobPayload, EmbeddingRunStatus } from "@developer-platform/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { decryptToken } from "../services/crypto.js";
import { downloadRepositoryArchive, GitHubArchiveError } from "../services/github-archive.js";
import { extractArchive, ExtractionLimitError } from "../ingestion/archive.js";
import { UnsafeArchivePathError } from "../ingestion/path-safety.js";
import { cleanupWorkspace, createWorkspace, workspacePathFor } from "../ingestion/workspace.js";
import { embedFilesForRun, type EmbeddingFileInput } from "./embed-files.js";

/**
 * Same tradeoff as apps/worker/src/analysis/pipeline.ts and for the same
 * reason: Phase 3's ingestion workspace is already gone by the time
 * embedding runs (a separate, later, user-triggered action), so embedding
 * re-downloads the archive at the ingestion's already-resolved commit SHA
 * and re-extracts it through the exact same secure pipeline, into its own
 * ephemeral workspace keyed by this EmbeddingRun's own id. See
 * docs/semantic-search.md for the full writeup.
 */

function errorCategoryFor(error: unknown): string {
  if (error instanceof GitHubArchiveError) return "github_archive";
  if (error instanceof ExtractionLimitError) return `extraction_limit:${error.reason}`;
  if (error instanceof UnsafeArchivePathError) return "unsafe_archive_path";
  return "unknown";
}

/** Same permanent-vs-transient split as the analysis pipeline, for the same reasons — plus "embedding isn't configured," which is always permanent (retrying without a key can never succeed). */
function isPermanentError(error: unknown): boolean {
  if (error instanceof UnsafeArchivePathError) return true;
  if (error instanceof ExtractionLimitError) return true;
  if (error instanceof GitHubArchiveError) return error.status === 404 || error.status === 401;
  if (error instanceof EmbeddingNotConfiguredError) return true;
  return false;
}

export class EmbeddingNotConfiguredError extends Error {
  constructor() {
    super("Embedding is not configured — OPENAI_API_KEY is not set");
    this.name = "EmbeddingNotConfiguredError";
  }
}

/** User-facing — never a stack trace, a file path, or repository content. */
export function userFacingMessageFor(error: unknown): string {
  if (error instanceof GitHubArchiveError) {
    return error.status === 404
      ? "Repository or commit not found on GitHub — it may have been deleted, renamed, or access revoked"
      : error.status === 401
        ? "GitHub connection is invalid — please reconnect your GitHub account"
        : "GitHub was unreachable while retrieving the repository";
  }
  if (error instanceof ExtractionLimitError) {
    return error.reason === "repository_too_large"
      ? `Repository exceeds the configured size limit (${env.MAX_REPOSITORY_SIZE_MB} MB)`
      : `Repository exceeds the configured file count limit (${env.MAX_FILES_PER_REPOSITORY} files)`;
  }
  if (error instanceof UnsafeArchivePathError) {
    return "Repository archive contained an unsafe file path and was rejected";
  }
  if (error instanceof EmbeddingNotConfiguredError) {
    return error.message;
  }
  return "Semantic indexing failed unexpectedly";
}

async function setStatus(embeddingRunId: string, status: EmbeddingRunStatus): Promise<void> {
  await prisma.embeddingRun.update({ where: { id: embeddingRunId }, data: { status } });
}

export async function failEmbedding(embeddingRunId: string, message: string): Promise<void> {
  await prisma.embeddingRun.update({
    where: { id: embeddingRunId },
    data: { status: "FAILED", error: message, completedAt: new Date() },
  });
}

export async function runEmbedding(payload: EmbeddingJobPayload): Promise<void> {
  const { embeddingRunId, repositoryId, analysisRunId } = payload;
  const log = logger.child({ embeddingRunId, repositoryId, analysisRunId });

  const embeddingRun = await prisma.embeddingRun.findUnique({
    where: { id: embeddingRunId },
    include: {
      analysisRun: {
        include: {
          ingestion: {
            include: {
              repository: { include: { user: { include: { githubAccount: true } } } },
              files: { where: { isSource: true } },
            },
          },
        },
      },
    },
  });

  if (!embeddingRun) {
    log.warn("embedding job for a missing embedding run record, skipping");
    return;
  }

  const { analysisRun } = embeddingRun;
  if (analysisRun.status !== "COMPLETED") {
    // Defensive — apps/api's POST /repositories/:id/embeddings already
    // requires a COMPLETED analysis run before enqueuing, but this is
    // re-checked here rather than trusted, same IDOR-safe-lookup instinct
    // as every ownership check elsewhere in this codebase.
    log.error({ analysisStatus: analysisRun.status }, "embedding job for an analysis run that is not COMPLETED");
    await failEmbedding(embeddingRunId, "Code analysis must be completed before the repository can be indexed for search");
    return;
  }

  const { ingestion } = analysisRun;
  const { repository, files: sourceFiles } = ingestion;
  const githubAccount = repository.user.githubAccount;

  if (!githubAccount) {
    log.error("repository owner has no connected GitHub account");
    await failEmbedding(embeddingRunId, "No GitHub account connected — please reconnect your GitHub account");
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(githubAccount.accessTokenEncrypted);
  } catch (error) {
    log.error({ err: error }, "failed to decrypt stored GitHub token");
    await failEmbedding(embeddingRunId, "GitHub connection is invalid — please reconnect your GitHub account");
    return;
  }

  const provider = createEmbeddingProviderFromEnv(env);
  if (!provider) {
    log.error("embedding requested but OPENAI_API_KEY is not configured");
    await failEmbedding(embeddingRunId, userFacingMessageFor(new EmbeddingNotConfiguredError()));
    return;
  }

  await createWorkspace(embeddingRunId);
  const startedAt = new Date();
  await prisma.embeddingRun.update({ where: { id: embeddingRunId }, data: { startedAt } });

  try {
    log.info("semantic indexing started");
    await setStatus(embeddingRunId, "EMBEDDING");

    const archiveStream = await downloadRepositoryArchive(accessToken, repository.owner, repository.name, ingestion.commitSha);
    const workspaceDir = workspacePathFor(embeddingRunId);
    const limits = {
      maxRepositorySizeBytes: env.MAX_REPOSITORY_SIZE_MB * 1024 * 1024,
      maxFileSizeBytes: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      maxFiles: env.MAX_FILES_PER_REPOSITORY,
    };
    await extractArchive(archiveStream, workspaceDir, limits);
    log.info("repository extraction completed");

    const files: EmbeddingFileInput[] = [];
    for (const file of sourceFiles) {
      if (!file.language) continue; // no language classification — chunking has nothing useful to key off of
      try {
        const content = await readFile(join(workspaceDir, file.path), "utf-8");
        files.push({ fileId: file.id, path: file.path, language: file.language, content });
      } catch (error) {
        log.warn({ err: error, path: file.path }, "skipping a file that couldn't be read from the fresh extraction");
      }
    }

    const symbols = await prisma.codeSymbol.findMany({
      where: { analysisRunId },
      select: { id: true, name: true, kind: true, startLine: true, endLine: true, parentId: true, fileId: true },
    });
    const symbolsByFileId = new Map<string, ChunkableSymbol[]>();
    for (const symbol of symbols) {
      const list = symbolsByFileId.get(symbol.fileId) ?? [];
      list.push({ id: symbol.id, name: symbol.name, kind: symbol.kind, startLine: symbol.startLine, endLine: symbol.endLine, parentId: symbol.parentId });
      symbolsByFileId.set(symbol.fileId, list);
    }

    const stats = await embedFilesForRun({
      repositoryId,
      analysisRunId,
      embeddingRunId,
      files,
      symbolsByFileId,
      provider,
      batchSize: env.EMBEDDING_BATCH_SIZE,
      chunkingConfig: {
        targetChars: env.CHUNK_TARGET_CHARS,
        maxChars: env.CHUNK_MAX_CHARS,
        overlapLines: env.CHUNK_OVERLAP_LINES,
      },
      onDiffComputed: async (diff) => {
        log.info(diff, "chunk diff computed");
        await prisma.embeddingRun.update({
          where: { id: embeddingRunId },
          data: { chunksDiscovered: diff.chunksDiscovered, chunksReused: diff.chunksReused, chunksDeleted: diff.chunksDeleted, chunksEmbedded: 0 },
        });
      },
      onBatchEmbedded: async (count) => {
        await prisma.embeddingRun.update({ where: { id: embeddingRunId }, data: { chunksEmbedded: { increment: count } } });
      },
    });

    await prisma.embeddingRun.update({
      where: { id: embeddingRunId },
      data: {
        status: "COMPLETED",
        chunksDiscovered: stats.chunksDiscovered,
        chunksReused: stats.chunksReused,
        chunksEmbedded: stats.chunksEmbedded,
        chunksDeleted: stats.chunksDeleted,
        completedAt: new Date(),
      },
    });
    log.info(stats, "semantic indexing completed");
  } catch (error) {
    const category = errorCategoryFor(error);

    if (isPermanentError(error)) {
      log.error({ err: error, errorCategory: category }, "semantic indexing failed permanently, not retrying");
      await failEmbedding(embeddingRunId, userFacingMessageFor(error));
    } else {
      log.warn({ err: error, errorCategory: category }, "semantic indexing attempt failed, may be retried by BullMQ");
      throw error;
    }
  } finally {
    await cleanupWorkspace(embeddingRunId);
  }
}
