import { prisma } from "@developer-platform/database";
import type { IngestionJobPayload, IngestionStatus } from "@developer-platform/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { decryptToken } from "../services/crypto.js";
import { downloadRepositoryArchive, GitHubArchiveError } from "../services/github-archive.js";
import { extractArchive, ExtractionLimitError } from "./archive.js";
import { UnsafeArchivePathError } from "./path-safety.js";
import { scanWorkspace } from "./scan.js";
import { cleanupWorkspace, createWorkspace, workspacePathFor } from "./workspace.js";

/**
 * Coarse, milestone-based progress — never implied to be precise. Retrieval
 * and extraction are streamed together (download piped straight into the
 * tar extractor, never buffered whole into memory — see archive.ts), so
 * "10% retrieved" marks a confirmed, live stream from GitHub, and "30%
 * extracted" marks the whole fused download+extract step finishing, not two
 * fully sequential phases with an independent checkpoint between them.
 */
const PROGRESS = {
  RETRIEVING: 10,
  EXTRACTED: 30,
  SCANNING: 50,
  METADATA_PERSISTED: 80,
  COMPLETED: 100,
} as const;

function errorCategoryFor(error: unknown): string {
  if (error instanceof GitHubArchiveError) return "github_archive";
  if (error instanceof ExtractionLimitError) return `extraction_limit:${error.reason}`;
  if (error instanceof UnsafeArchivePathError) return "unsafe_archive_path";
  return "unknown";
}

/**
 * Permanent failures (a hostile/malformed archive, a repository that
 * genuinely doesn't exist or isn't accessible, a repository that's
 * genuinely too big) are marked FAILED immediately and never retried —
 * retrying can't fix any of them. Everything else (network blips, GitHub
 * being briefly unreachable, an unexpected exception) is treated as
 * transient by default: this function returns false, the error propagates,
 * and BullMQ's own retry/backoff takes over (see jobs/ingestion-job.ts) —
 * only the final, exhausted attempt gets marked FAILED.
 */
function isPermanentError(error: unknown): boolean {
  if (error instanceof UnsafeArchivePathError) return true;
  if (error instanceof ExtractionLimitError) return true;
  if (error instanceof GitHubArchiveError) return error.status === 404 || error.status === 401;
  return false;
}

/** User-facing — never includes a stack trace, a file path, or repository content. */
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
  return "Repository ingestion failed unexpectedly";
}

async function setStatus(
  ingestionId: string,
  status: IngestionStatus,
  progress: number,
  extra: { startedAt?: Date } = {},
): Promise<void> {
  await prisma.ingestion.update({
    where: { id: ingestionId },
    data: { status, progress, ...extra },
  });
}

export async function failIngestion(ingestionId: string, message: string): Promise<void> {
  await prisma.ingestion.update({
    where: { id: ingestionId },
    data: { status: "FAILED", error: message, completedAt: new Date() },
  });
}

/**
 * Runs one ingestion end to end. Owns every state transition (the API only
 * ever creates the initial PENDING/QUEUED row) and always cleans up its
 * temporary workspace, success or failure — see docs/repository-ingestion.md.
 */
export async function runIngestion(payload: IngestionJobPayload): Promise<void> {
  const { ingestionId, repositoryId } = payload;
  const log = logger.child({ ingestionId, repositoryId });

  const ingestion = await prisma.ingestion.findUnique({
    where: { id: ingestionId },
    include: { repository: { include: { user: { include: { githubAccount: true } } } } },
  });

  if (!ingestion) {
    // The ingestion row (or its repository) was deleted after the job was
    // enqueued — nothing to do, and nothing to mark failed.
    log.warn("ingestion job for a missing ingestion record, skipping");
    return;
  }

  const { repository } = ingestion;
  const githubAccount = repository.user.githubAccount;

  if (!githubAccount) {
    log.error("repository owner has no connected GitHub account");
    await failIngestion(ingestionId, "No GitHub account connected — please reconnect your GitHub account");
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(githubAccount.accessTokenEncrypted);
  } catch (error) {
    log.error({ err: error }, "failed to decrypt stored GitHub token");
    await failIngestion(ingestionId, "GitHub connection is invalid — please reconnect your GitHub account");
    return;
  }

  await createWorkspace(ingestionId);
  const startedAt = new Date();

  try {
    log.info("repository ingestion started");

    await setStatus(ingestionId, "RETRIEVING", 0, { startedAt });
    const archiveStream = await downloadRepositoryArchive(
      accessToken,
      repository.owner,
      repository.name,
      ingestion.commitSha,
    );
    log.info("repository archive retrieval started");

    await setStatus(ingestionId, "EXTRACTING", PROGRESS.RETRIEVING);
    const limits = {
      maxRepositorySizeBytes: env.MAX_REPOSITORY_SIZE_MB * 1024 * 1024,
      maxFileSizeBytes: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      maxFiles: env.MAX_FILES_PER_REPOSITORY,
    };
    await extractArchive(archiveStream, workspacePathFor(ingestionId), limits);
    log.info("repository extraction completed");

    await setStatus(ingestionId, "SCANNING", PROGRESS.EXTRACTED);
    log.info("repository scan started");
    const files = await scanWorkspace(workspacePathFor(ingestionId));
    log.info({ fileCount: files.length }, "repository scan completed");

    await prisma.ingestion.update({ where: { id: ingestionId }, data: { progress: PROGRESS.SCANNING } });
    if (files.length > 0) {
      await prisma.repositoryFile.createMany({
        data: files.map((file) => ({ ingestionId, ...file })),
        skipDuplicates: true,
      });
    }
    await prisma.ingestion.update({ where: { id: ingestionId }, data: { progress: PROGRESS.METADATA_PERSISTED } });
    log.info("repository ingestion metadata persisted");

    const sourceFileCount = files.filter((file) => file.isSource).length;
    await prisma.ingestion.update({
      where: { id: ingestionId },
      data: {
        status: "COMPLETED",
        progress: PROGRESS.COMPLETED,
        fileCount: files.length,
        sourceFileCount,
        completedAt: new Date(),
      },
    });
    log.info({ fileCount: files.length, sourceFileCount }, "repository ingestion completed");
  } catch (error) {
    const category = errorCategoryFor(error);

    if (isPermanentError(error)) {
      log.error({ err: error, errorCategory: category }, "repository ingestion failed permanently, not retrying");
      await failIngestion(ingestionId, userFacingMessageFor(error));
    } else {
      log.warn(
        { err: error, errorCategory: category },
        "repository ingestion attempt failed, may be retried by BullMQ",
      );
      // Deliberately not marked FAILED here — a later attempt may still
      // succeed. jobs/ingestion-job.ts's `failed` handler marks it FAILED
      // once BullMQ's configured retries are actually exhausted.
      throw error;
    }
  } finally {
    await cleanupWorkspace(ingestionId);
  }
}
