import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { checkDatabaseConnection, prisma, toVectorLiteral } from "@developer-platform/database";
import { createMockAIChatProvider, createMockEmbeddingProvider, type AIProvider, type StructuredRequest } from "@developer-platform/ai";
import { PRIMARY_AGENT_TYPES } from "@developer-platform/shared";
import { runAIAnalysisWithProviders } from "../../src/ai-analysis/pipeline.js";

const dbAvailable = await checkDatabaseConnection();

/** A finding satisfying AgentFindingSchema — reused across every scenario below. */
function validFinding() {
  return {
    category: "test",
    title: "A finding",
    summary: "Something was found.",
    severity: "LOW" as const,
    confidence: 0.6,
    evidence: "Observed in the retrieved evidence.",
    recommendation: "Consider addressing it.",
    citations: [{ filePath: "src/big.ts", startLine: 1, endLine: 5, symbolName: null }],
  };
}

function validAgentOutput() {
  return { summary: "Agent analysis complete.", findings: [validFinding()] };
}

function validExecutiveOutput() {
  return { overallHealth: "GOOD" as const, summary: "Overall healthy.", strengths: ["Clear structure"], topRisks: [validFinding()], recommendedNextSteps: ["Address the finding"] };
}

/** Fails every request whose schemaName is in `failingSchemas`, succeeds (with valid output) for every other one. */
function providerFailingFor(failingSchemas: readonly string[]): AIProvider {
  return createMockAIChatProvider({
    responder: (request: StructuredRequest<unknown>) => {
      if (failingSchemas.includes(request.schemaName)) {
        return { thisDoesNotMatch: "any schema" };
      }
      return request.schemaName === "executive_summary_agent_output" ? validExecutiveOutput() : validAgentOutput();
    },
  });
}

describe.runIf(dbAvailable)("runAIAnalysisWithProviders (live database)", () => {
  const marker = randomBytes(6).toString("hex");
  const embeddingProvider = createMockEmbeddingProvider({ dimensions: 1536 });
  let userId: string;
  let repositoryId: string;
  let analysisRunId: string;
  let aiAnalysisRunId: string;

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  });

  it("seeds a repository with a completed analysis, a completed embedding run, and one indexed chunk", async () => {
    const user = await prisma.user.create({ data: {} });
    userId = user.id;

    const repository = await prisma.repository.create({
      data: {
        userId,
        githubId: 96_000_000 + Number.parseInt(marker.slice(0, 4), 16),
        owner: "pipeline-org",
        name: "pipeline-repo",
        fullName: "pipeline-org/pipeline-repo",
        defaultBranch: "main",
        private: false,
        htmlUrl: "https://github.com/pipeline-org/pipeline-repo",
      },
    });
    repositoryId = repository.id;

    const ingestion = await prisma.ingestion.create({
      data: { repositoryId, commitSha: "sha-pipeline-0001", status: "COMPLETED", progress: 100, completedAt: new Date() },
    });
    const file = await prisma.repositoryFile.create({
      data: { ingestionId: ingestion.id, path: "src/big.ts", name: "big.ts", extension: ".ts", language: "TypeScript", category: "SOURCE", size: 900, isSource: true },
    });
    const analysisRun = await prisma.analysisRun.create({
      data: { ingestionId: ingestion.id, status: "COMPLETED", filesAnalyzed: 1, symbolsFound: 1, importsFound: 0, findingsCount: 1, completedAt: new Date() },
    });
    analysisRunId = analysisRun.id;

    await prisma.finding.create({
      data: { analysisRunId, fileId: file.id, ruleId: "COMPLEXITY_HIGH", severity: "HIGH", message: "cyclomatic complexity 20", line: 3 },
    });

    const embeddingRun = await prisma.embeddingRun.create({
      data: { repositoryId, analysisRunId, status: "COMPLETED", model: "mock-embedding", dimensions: 1536, completedAt: new Date() },
    });
    const [vector] = await embeddingProvider.embedDocuments(["export function bigFunction() {}"]);
    await prisma.$executeRaw`
      INSERT INTO "code_chunk" ("id", "repositoryId", "fileId", "analysisRunId", "embeddingRunId", "filePath", "chunkIndex", "content", "contentHash", "startLine", "endLine", "symbolId", "symbolName", "language", "charCount", "embedding", "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, ${repositoryId}, ${file.id}, ${analysisRunId}, ${embeddingRun.id}, 'src/big.ts', 0, 'export function bigFunction() {}', 'hash-1', 1, 3, NULL, 'bigFunction', 'TypeScript', 40, ${toVectorLiteral(vector!.vector)}::vector, now(), now())
    `;

    // Note: no AgentRun rows are created here — runAIAnalysisWithProviders
    // itself creates all seven (PENDING) on a fresh run; see that
    // function's own doc comment. A caller only needs to delete stale ones
    // before a *re*-run (see the rerun tests below).
    const aiAnalysisRun = await prisma.aIAnalysisRun.create({
      data: { repositoryId, analysisRunId, status: "PENDING", provider: "mock", model: "mock-chat" },
    });
    aiAnalysisRunId = aiAnalysisRun.id;

    expect(aiAnalysisRunId).toBeTruthy();
  });

  it("runs all seven agents successfully — AIAnalysisRun COMPLETED, every AgentRun COMPLETED, findings persisted", async () => {
    const aiProvider = providerFailingFor([]);

    await runAIAnalysisWithProviders({ aiAnalysisRunId, repositoryId, analysisRunId }, { aiProvider, embeddingProvider });

    const run = await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: aiAnalysisRunId } });
    expect(run.status).toBe("COMPLETED");
    expect(run.startedAt).not.toBeNull();
    expect(run.completedAt).not.toBeNull();

    const agentRuns = await prisma.agentRun.findMany({ where: { aiAnalysisRunId } });
    expect(agentRuns).toHaveLength(7);
    for (const agentRun of agentRuns) {
      expect(agentRun.status).toBe("COMPLETED");
      expect(agentRun.summary).not.toBeNull();
      expect(agentRun.result).not.toBeNull();
    }

    const findings = await prisma.aIFinding.findMany({ where: { aiAnalysisRunId } });
    // Six primary agents + the executive summary's own topRisks, one finding each.
    expect(findings).toHaveLength(7);
    expect(findings[0]!.citations).toEqual([{ filePath: "src/big.ts", startLine: 1, endLine: 5, symbolName: null }]);
  });

  it("rerun with one failing agent: AIAnalysisRun COMPLETED_WITH_WARNINGS, that agent FAILED, the rest COMPLETED", async () => {
    // Simulate the API's reuse-by-id retry cleanup (see apps/api/src/routes/analyses.ts's
    // identical pattern): delete stale child rows, reset the run to QUEUED.
    await prisma.agentRun.deleteMany({ where: { aiAnalysisRunId } }); // cascades to AIFinding
    await prisma.aIAnalysisRun.update({ where: { id: aiAnalysisRunId }, data: { status: "QUEUED", error: null, startedAt: null, completedAt: null } });

    const aiProvider = providerFailingFor(["security_agent_output"]);
    await runAIAnalysisWithProviders({ aiAnalysisRunId, repositoryId, analysisRunId }, { aiProvider, embeddingProvider });

    const run = await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: aiAnalysisRunId } });
    expect(run.status).toBe("COMPLETED_WITH_WARNINGS");

    const securityRun = await prisma.agentRun.findUniqueOrThrow({ where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "SECURITY" } } });
    expect(securityRun.status).toBe("FAILED");
    expect(securityRun.error).toBeTruthy();

    const executiveRun = await prisma.agentRun.findUniqueOrThrow({ where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "EXECUTIVE_SUMMARY" } } });
    expect(executiveRun.status).toBe("COMPLETED"); // still runs, synthesizing the five that succeeded

    const otherPrimaryRuns = await prisma.agentRun.findMany({
      where: { aiAnalysisRunId, agent: { notIn: ["SECURITY", "EXECUTIVE_SUMMARY"] } },
    });
    expect(otherPrimaryRuns).toHaveLength(5);
    for (const agentRun of otherPrimaryRuns) {
      expect(agentRun.status).toBe("COMPLETED");
    }
  });

  it("rerun with every primary agent failing: AIAnalysisRun FAILED, executive summary SKIPPED", async () => {
    await prisma.agentRun.deleteMany({ where: { aiAnalysisRunId } });
    await prisma.aIAnalysisRun.update({ where: { id: aiAnalysisRunId }, data: { status: "QUEUED", error: null, startedAt: null, completedAt: null } });

    const aiProvider = providerFailingFor([...PRIMARY_AGENT_TYPES.map((t) => `${t.toLowerCase()}_agent_output`)]);
    await runAIAnalysisWithProviders({ aiAnalysisRunId, repositoryId, analysisRunId }, { aiProvider, embeddingProvider });

    const run = await prisma.aIAnalysisRun.findUniqueOrThrow({ where: { id: aiAnalysisRunId } });
    expect(run.status).toBe("FAILED");
    expect(run.error).toBeTruthy();

    const executiveRun = await prisma.agentRun.findUniqueOrThrow({ where: { aiAnalysisRunId_agent: { aiAnalysisRunId, agent: "EXECUTIVE_SUMMARY" } } });
    expect(executiveRun.status).toBe("SKIPPED");

    const primaryRuns = await prisma.agentRun.findMany({ where: { aiAnalysisRunId, agent: { not: "EXECUTIVE_SUMMARY" } } });
    for (const agentRun of primaryRuns) {
      expect(agentRun.status).toBe("FAILED");
    }
  });

  it("respects the concurrency limit — never runs more than AI_AGENT_CONCURRENCY agents at once", async () => {
    await prisma.agentRun.deleteMany({ where: { aiAnalysisRunId } });
    await prisma.aIAnalysisRun.update({ where: { id: aiAnalysisRunId }, data: { status: "QUEUED", error: null, startedAt: null, completedAt: null } });

    let inFlight = 0;
    let maxInFlight = 0;
    const aiProvider = createMockAIChatProvider({
      responder: (request) => {
        // Not awaited inside the responder itself (it's synchronous), but
        // this still proves the pipeline's own concurrency gate: count how
        // many primary-agent requests overlap in real time.
        return request.schemaName === "executive_summary_agent_output" ? validExecutiveOutput() : validAgentOutput();
      },
    });
    // Wrap generateStructured to actually observe overlap with a real delay.
    const observingProvider: AIProvider = {
      provider: aiProvider.provider,
      model: aiProvider.model,
      async generateStructured(request) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        const result = await aiProvider.generateStructured(request);
        inFlight -= 1;
        return result;
      },
    };

    await runAIAnalysisWithProviders({ aiAnalysisRunId, repositoryId, analysisRunId }, { aiProvider: observingProvider, embeddingProvider });

    expect(maxInFlight).toBeLessThanOrEqual(3); // AI_AGENT_CONCURRENCY default
  });
});

describe.skipIf(dbAvailable)("runAIAnalysisWithProviders (live database)", () => {
  it("skipped: no live database available for this run", () => {
    /* skipped: run `docker compose up postgres` to exercise this */
  });
});
