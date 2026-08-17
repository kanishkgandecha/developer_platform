/**
 * Mirrors the Prisma `AnalysisStatus` enum (packages/database/prisma/schema.prisma).
 * Duplicated here (not imported from @prisma/client) so apps/web — which
 * never depends on Prisma directly — can use the same literal type, the
 * same pattern as IngestionStatus in ./ingestion.ts.
 */
export type AnalysisStatus =
  | "PENDING"
  | "QUEUED"
  | "PARSING"
  | "INDEXING"
  | "ANALYZING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

/** States where a job is still queued or actively being processed by the worker. */
export const ACTIVE_ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  "PENDING",
  "QUEUED",
  "PARSING",
  "INDEXING",
  "ANALYZING",
];

export function isActiveAnalysisStatus(status: AnalysisStatus): boolean {
  return (ACTIVE_ANALYSIS_STATUSES as string[]).includes(status);
}

export type Severity = "INFO" | "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export interface SeverityCounts {
  CRITICAL: number;
  HIGH: number;
  MEDIUM: number;
  LOW: number;
  INFO: number;
}

export interface AnalysisRunDto {
  id: string;
  ingestionId: string;
  status: AnalysisStatus;
  error: string | null;
  filesAnalyzed: number | null;
  symbolsFound: number | null;
  importsFound: number | null;
  findingsCount: number | null;
  /** Only present once COMPLETED — a cheap way for the UI to show the severity breakdown without a second request. */
  severityCounts: SeverityCounts | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FindingDto {
  id: string;
  analysisRunId: string;
  fileId: string | null;
  filePath: string | null;
  ruleId: string;
  severity: Severity;
  message: string;
  line: number | null;
  column: number | null;
  metadata: Record<string, unknown> | null;
}

export interface CodeSymbolDto {
  id: string;
  fileId: string;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  exported: boolean;
  parentId: string | null;
  parentName: string | null;
  signature: string | null;
  complexity: number | null;
  parameterCount: number | null;
}

export interface CodeImportDto {
  id: string;
  fileId: string;
  filePath: string;
  source: string;
  kind: string;
  line: number;
  resolvedFileId: string | null;
  resolvedFilePath: string | null;
}

export interface CodeMetricDto {
  fileId: string;
  filePath: string;
  lineCount: number;
  codeLineCount: number;
  commentLineCount: number;
  blankLineCount: number;
  functionCount: number;
  classCount: number;
  importCount: number;
  exportCount: number;
  complexity: number | null;
}

/** BullMQ queue name — a shared constant so apps/api (producer) and apps/worker (consumer) can't drift on the literal string, same pattern as INGESTION_QUEUE_NAME. */
export const ANALYSIS_QUEUE_NAME = "code-analysis";

/**
 * Job payload: identifiers only — the worker looks up the ingestion,
 * repository, and every RepositoryFile it needs server-side via Postgres.
 * Nothing here ever touches source code or a GitHub token (this queue's
 * payload lives in Redis, same constraint as IngestionJobPayload).
 */
export interface AnalysisJobPayload {
  analysisRunId: string;
  ingestionId: string;
}
