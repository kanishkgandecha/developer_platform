import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeFile, buildDependencyGraph } from "@developer-platform/code-analysis";
import type { DependencyEdge, Finding, ParsedFile } from "@developer-platform/code-analysis";
import { prisma } from "@developer-platform/database";
import type { Prisma } from "@prisma/client";
import type { AnalysisJobPayload, AnalysisStatus } from "@developer-platform/shared";
import { env } from "../env.js";
import { logger } from "../logger.js";
import { decryptToken } from "../services/crypto.js";
import { downloadRepositoryArchive, GitHubArchiveError } from "../services/github-archive.js";
import { extractArchive, ExtractionLimitError } from "../ingestion/archive.js";
import { UnsafeArchivePathError } from "../ingestion/path-safety.js";
import { cleanupWorkspace, createWorkspace, workspacePathFor } from "../ingestion/workspace.js";

/**
 * Phase 3's ingestion workspace is deleted the moment ingestion finishes
 * (by design — RepositoryFile stores metadata only, never file content, see
 * docs/repository-ingestion.md). Analysis is a separate, later, user-
 * triggered action, so there is no still-open workspace to reuse by the
 * time it runs. Rather than persisting repository content at rest (which
 * would contradict Phase 3's threat model) or reinventing retrieval,
 * analysis re-downloads the archive at the ingestion's *already-resolved*
 * commit SHA (no new GitHub API call to re-resolve a SHA — it reuses the
 * one `Ingestion.commitSha` already recorded) and re-extracts it through
 * the exact same secure, size/path-limited pipeline Phase 3 built
 * (services/github-archive.ts, ingestion/archive.ts, ingestion/path-safety.ts,
 * ingestion/workspace.ts — imported directly, not duplicated), into its
 * own ephemeral workspace keyed by the AnalysisRun's own id. See
 * docs/code-intelligence.md for the full tradeoff writeup.
 */

function errorCategoryFor(error: unknown): string {
  if (error instanceof GitHubArchiveError) return "github_archive";
  if (error instanceof ExtractionLimitError) return `extraction_limit:${error.reason}`;
  if (error instanceof UnsafeArchivePathError) return "unsafe_archive_path";
  return "unknown";
}

/** Same permanent-vs-transient split as apps/worker/src/ingestion/pipeline.ts, for the same reasons. */
function isPermanentError(error: unknown): boolean {
  if (error instanceof UnsafeArchivePathError) return true;
  if (error instanceof ExtractionLimitError) return true;
  if (error instanceof GitHubArchiveError) return error.status === 404 || error.status === 401;
  return false;
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
  return "Code analysis failed unexpectedly";
}

/**
 * Unlike Ingestion, AnalysisRun has no numeric `progress` column — the
 * state machine's named stages (PARSING/INDEXING/ANALYZING) are the UI's
 * only granularity in Phase 4, no percentage bar.
 */
async function setStatus(analysisRunId: string, status: AnalysisStatus): Promise<void> {
  await prisma.analysisRun.update({ where: { id: analysisRunId }, data: { status } });
}

export async function failAnalysis(analysisRunId: string, message: string): Promise<void> {
  await prisma.analysisRun.update({
    where: { id: analysisRunId },
    data: { status: "FAILED", error: message, completedAt: new Date() },
  });
}

export async function runAnalysis(payload: AnalysisJobPayload): Promise<void> {
  const { analysisRunId, ingestionId } = payload;
  const log = logger.child({ analysisRunId, ingestionId });

  const analysisRun = await prisma.analysisRun.findUnique({
    where: { id: analysisRunId },
    include: {
      ingestion: {
        include: {
          repository: { include: { user: { include: { githubAccount: true } } } },
          files: { where: { isSource: true } },
        },
      },
    },
  });

  if (!analysisRun) {
    log.warn("analysis job for a missing analysis run record, skipping");
    return;
  }

  const { ingestion } = analysisRun;
  const { repository, files: sourceFiles } = ingestion;
  const githubAccount = repository.user.githubAccount;

  if (!githubAccount) {
    log.error("repository owner has no connected GitHub account");
    await failAnalysis(analysisRunId, "No GitHub account connected — please reconnect your GitHub account");
    return;
  }

  let accessToken: string;
  try {
    accessToken = decryptToken(githubAccount.accessTokenEncrypted);
  } catch (error) {
    log.error({ err: error }, "failed to decrypt stored GitHub token");
    await failAnalysis(analysisRunId, "GitHub connection is invalid — please reconnect your GitHub account");
    return;
  }

  await createWorkspace(analysisRunId);
  const startedAt = new Date();
  await prisma.analysisRun.update({ where: { id: analysisRunId }, data: { startedAt } });

  try {
    log.info("code analysis started");

    await setStatus(analysisRunId, "PARSING");
    const archiveStream = await downloadRepositoryArchive(
      accessToken,
      repository.owner,
      repository.name,
      ingestion.commitSha,
    );
    log.info("repository archive retrieval started");

    const workspaceDir = workspacePathFor(analysisRunId);
    const limits = {
      maxRepositorySizeBytes: env.MAX_REPOSITORY_SIZE_MB * 1024 * 1024,
      maxFileSizeBytes: env.MAX_FILE_SIZE_MB * 1024 * 1024,
      maxFiles: env.MAX_FILES_PER_REPOSITORY,
    };
    await extractArchive(archiveStream, workspaceDir, limits);
    log.info("repository extraction completed");

    // Parse every already-classified SOURCE file. Files unreadable in this
    // fresh extraction (should be essentially impossible — same commit SHA,
    // same deterministic tarball — but defensively handled) are skipped,
    // logged, and don't fail the whole run.
    const parsedFiles: ParsedFile[] = [];
    const allFindings: Finding[] = [];
    const metricsByPath = new Map<string, ReturnType<typeof analyzeFile>["metrics"]>();

    for (const file of sourceFiles) {
      let content: string;
      try {
        content = await readFile(join(workspaceDir, file.path), "utf-8");
      } catch (error) {
        log.warn({ err: error, path: file.path }, "skipping a file that couldn't be read from the fresh extraction");
        continue;
      }

      const { parsed, metrics, findings } = analyzeFile(file.path, content, file.language);
      parsedFiles.push(parsed);
      metricsByPath.set(file.path, metrics);
      allFindings.push(...findings);
    }
    log.info({ filesParsed: parsedFiles.length }, "file parsing completed");

    await setStatus(analysisRunId, "INDEXING");
    const fileIdByPath = new Map(sourceFiles.map((f) => [f.path, f.id]));

    const symbolIdByFileAndName = new Map<string, string>();
    const codeSymbolRows = parsedFiles.flatMap((file) => {
      const fileId = fileIdByPath.get(file.path);
      if (!fileId) return [];
      return file.symbols.map((sym) => {
        const id = randomUUID();
        symbolIdByFileAndName.set(`${file.path}::${sym.name}`, id);
        return { id, fileId, symbol: sym, filePath: file.path };
      });
    });

    if (codeSymbolRows.length > 0) {
      await prisma.codeSymbol.createMany({
        data: codeSymbolRows.map((row) => ({
          id: row.id,
          analysisRunId,
          fileId: row.fileId,
          name: row.symbol.name,
          kind: row.symbol.kind,
          startLine: row.symbol.startLine,
          endLine: row.symbol.endLine,
          exported: row.symbol.exported,
          signature: row.symbol.signature,
          parentId: row.symbol.parentName
            ? (symbolIdByFileAndName.get(`${row.filePath}::${row.symbol.parentName}`) ?? null)
            : null,
          complexity: row.symbol.complexity,
          parameterCount: row.symbol.parameterCount,
        })),
      });
    }

    const dependencyEdges: DependencyEdge[] = buildDependencyGraph(parsedFiles);
    const edgesBySourceFile = new Map<string, DependencyEdge[]>();
    for (const edge of dependencyEdges) {
      const list = edgesBySourceFile.get(edge.sourceFile) ?? [];
      list.push(edge);
      edgesBySourceFile.set(edge.sourceFile, list);
    }

    const codeImportRows = parsedFiles.flatMap((file) => {
      const fileId = fileIdByPath.get(file.path);
      if (!fileId) return [];
      // Imports and their resolved edges are produced from the same
      // per-file array in the same order by parse-file.ts and
      // dependency-graph.ts respectively — safe to zip positionally.
      const edgesForFile = edgesBySourceFile.get(file.path) ?? [];
      return file.imports.map((imp, index) => {
        const edge = edgesForFile[index];
        const resolvedFileId = edge?.targetFile ? (fileIdByPath.get(edge.targetFile) ?? null) : null;
        return {
          analysisRunId,
          fileId,
          source: imp.source,
          kind: imp.kind,
          line: imp.line,
          resolvedFileId,
        };
      });
    });
    if (codeImportRows.length > 0) {
      await prisma.codeImport.createMany({ data: codeImportRows });
    }

    const codeMetricRows = parsedFiles.flatMap((file) => {
      const fileId = fileIdByPath.get(file.path);
      const metrics = metricsByPath.get(file.path);
      if (!fileId || !metrics) return [];
      return [{ analysisRunId, fileId, ...metrics }];
    });
    if (codeMetricRows.length > 0) {
      await prisma.codeMetric.createMany({ data: codeMetricRows });
    }

    if (allFindings.length > 0) {
      await prisma.finding.createMany({
        data: allFindings.map((f) => ({
          analysisRunId,
          fileId: fileIdByPath.get(f.file) ?? null,
          ruleId: f.ruleId,
          severity: f.severity,
          message: f.message,
          line: f.line,
          column: f.column,
          metadata: f.metadata as Prisma.InputJsonValue,
        })),
      });
    }
    log.info(
      { symbols: codeSymbolRows.length, imports: codeImportRows.length, findings: allFindings.length },
      "analysis metadata persisted",
    );

    await setStatus(analysisRunId, "ANALYZING");
    if (dependencyEdges.length > 0) {
      await prisma.dependencyEdge.createMany({
        data: dependencyEdges.flatMap((edge) => {
          const sourceFileId = fileIdByPath.get(edge.sourceFile);
          if (!sourceFileId) return [];
          return [
            {
              analysisRunId,
              sourceFileId,
              targetFileId: edge.targetFile ? (fileIdByPath.get(edge.targetFile) ?? null) : null,
              external: edge.external,
              kind: edge.kind,
              specifier: edge.specifier,
            },
          ];
        }),
      });
    }
    log.info({ dependencyEdges: dependencyEdges.length }, "dependency graph persisted");

    await prisma.analysisRun.update({
      where: { id: analysisRunId },
      data: {
        status: "COMPLETED",
        filesAnalyzed: parsedFiles.length,
        symbolsFound: codeSymbolRows.length,
        importsFound: codeImportRows.length,
        findingsCount: allFindings.length,
        completedAt: new Date(),
      },
    });
    log.info(
      { filesAnalyzed: parsedFiles.length, symbolsFound: codeSymbolRows.length, findingsCount: allFindings.length },
      "code analysis completed",
    );
  } catch (error) {
    const category = errorCategoryFor(error);

    if (isPermanentError(error)) {
      log.error({ err: error, errorCategory: category }, "code analysis failed permanently, not retrying");
      await failAnalysis(analysisRunId, userFacingMessageFor(error));
    } else {
      log.warn({ err: error, errorCategory: category }, "code analysis attempt failed, may be retried by BullMQ");
      throw error;
    }
  } finally {
    await cleanupWorkspace(analysisRunId);
  }
}
