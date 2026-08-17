import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, prisma, toVectorLiteral } from "@developer-platform/database";
import { createMockEmbeddingProvider, PRIMARY_AGENT_SPECS } from "@developer-platform/ai";
import { gatherEvidenceForAgent } from "../../src/ai-analysis/evidence.js";

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("gatherEvidenceForAgent (live database)", () => {
  const marker = randomBytes(6).toString("hex");
  const embeddingProvider = createMockEmbeddingProvider({ dimensions: 1536 });
  let userId: string;
  let repositoryId: string;
  let analysisRunId: string;
  let fileId: string;

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("seeds a repository with deterministic findings, metrics, and an indexed chunk", async () => {
    const user = await prisma.user.create({ data: {} });
    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        userId,
        githubId: 95_000_000 + Number.parseInt(marker.slice(0, 4), 16),
        owner: "evidence-org",
        name: "evidence-repo",
        fullName: "evidence-org/evidence-repo",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/evidence-org/evidence-repo",
        description: "A repository used to test evidence gathering",
      },
    });
    repositoryId = repository.id;

    const ingestion = await prisma.ingestion.create({
      data: { repositoryId, commitSha: "sha-evidence-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    const file = await prisma.repositoryFile.create({
      data: {
        ingestionId: ingestion.id,
        path: "src/big.ts",
        name: "big.ts",
        extension: ".ts",
        language: "TypeScript",
        category: "SOURCE",
        size: 5000,
        isSource: true,
      },
    });
    fileId = file.id;

    const analysisRun = await prisma.analysisRun.create({
      data: { ingestionId: ingestion.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 3, importsFound: 2, findingsCount: 2, completedAt: new Date() },
    });
    analysisRunId = analysisRun.id;

    await prisma.codeMetric.create({
      data: { analysisRunId, fileId, lineCount: 900, codeLineCount: 800, commentLineCount: 50, blankLineCount: 50, functionCount: 10, classCount: 1, importCount: 2, exportCount: 3, complexity: 30 },
    });

    await prisma.finding.createMany({
      data: [
        { analysisRunId, fileId, ruleId: "COMPLEXITY_HIGH", severity: "HIGH", message: "cyclomatic complexity 30", line: 5 },
        { analysisRunId, fileId, ruleId: "TODO_COMMENT", severity: "INFO", message: "TODO found", line: 20 },
        // Deliberately unrelated to the Code Quality agent's relevantRuleIds — should be excluded when filtering for that agent.
        { analysisRunId, fileId, ruleId: "FILE_TOO_LARGE", severity: "MEDIUM", message: "file too large", line: null },
      ],
    });

    const embeddingRun = await prisma.embeddingRun.create({
      data: { repositoryId, analysisRunId, status: "COMPLETED", model: "mock-embedding", dimensions: 1536, completedAt: new Date() },
    });

    const [vector] = await embeddingProvider.embedDocuments(["export function bigFunction() { /* very long body */ }"]);
    await prisma.$executeRaw`
      INSERT INTO "code_chunk" ("id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath", "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName", "language", "charCount", "embedding", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${repositoryId}, ${fileId}, ${analysisRunId}, ${embeddingRun.id}, 'src/big.ts', 0, 'export function bigFunction() { /* very long body */ }', 'hash-1', 1, 900, NULL, 'bigFunction', 'TypeScript', 60, ${toVectorLiteral(vector!.vector)}::vector, now(), now())
    `;

    expect(analysisRunId).toBeTruthy();
  });

  it("includes real repository metadata, deterministic counts, and largest files", async () => {
    const architectureSpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "ARCHITECTURE")!;
    const evidence = await gatherEvidenceForAgent({ repositoryId, analysisRunId, spec: architectureSpec, embeddingProvider });

    expect(evidence.repository.fullName).toBe("evidence-org/evidence-repo");
    expect(evidence.deterministic.filesAnalyzed).toBe(1);
    expect(evidence.deterministic.symbolsFound).toBe(3);
    expect(evidence.deterministic.severityCounts).toMatchObject({ HIGH: 1, MEDIUM: 1, INFO: 1 });
    expect(evidence.deterministic.largestFiles).toEqual([{ filePath: "src/big.ts", lineCount: 900, complexity: 30 }]);
  });

  it("filters relevantFindings to the agent's relevantRuleIds when set", async () => {
    const codeQualitySpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "CODE_QUALITY")!;
    const evidence = await gatherEvidenceForAgent({ repositoryId, analysisRunId, spec: codeQualitySpec, embeddingProvider });

    const ruleIds = evidence.deterministic.relevantFindings.map((f) => f.ruleId);
    expect(ruleIds).toEqual(expect.arrayContaining(["COMPLEXITY_HIGH", "TODO_COMMENT"]));
  });

  it("includes all findings (no filter) for an agent without relevantRuleIds", async () => {
    const architectureSpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "ARCHITECTURE")!;
    expect(architectureSpec.relevantRuleIds).toBeUndefined();
    const evidence = await gatherEvidenceForAgent({ repositoryId, analysisRunId, spec: architectureSpec, embeddingProvider });
    expect(evidence.deterministic.relevantFindings.length).toBe(3);
  });

  it("retrieves and bounds RAG evidence using the agent's own retrieval query", async () => {
    const architectureSpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "ARCHITECTURE")!;
    const evidence = await gatherEvidenceForAgent({ repositoryId, analysisRunId, spec: architectureSpec, embeddingProvider });

    expect(evidence.ragContext.chunks.length).toBeGreaterThan(0);
    expect(evidence.ragContext.chunks[0]!.citation).toContain("src/big.ts");
  });
});

describe.skipIf(dbAvailable)("gatherEvidenceForAgent (live database)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
