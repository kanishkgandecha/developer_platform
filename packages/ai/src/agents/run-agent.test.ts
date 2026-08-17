import { describe, expect, it } from "vitest";
import { createMockAIChatProvider } from "../chat/mock-provider.js";
import type { RagContext } from "../rag/types.js";
import { runAgent } from "./run-agent.js";
import { PRIMARY_AGENT_SPECS } from "./specs.js";
import type { AgentEvidence } from "./types.js";

const emptyRagContext: RagContext = { chunks: [], totalCharacters: 0, truncated: 0 };

function evidenceFixture(overrides: Partial<AgentEvidence> = {}): AgentEvidence {
  return {
    repository: { fullName: "acme/widgets", description: "A widget factory", defaultBranch: "main" },
    deterministic: {
      filesAnalyzed: 42,
      symbolsFound: 200,
      importsFound: 80,
      findingsCount: 3,
      severityCounts: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 0, INFO: 0 },
      largestFiles: [{ filePath: "src/big.ts", lineCount: 900, complexity: 40 }],
      relevantFindings: [
        { ruleId: "COMPLEXITY_HIGH", severity: "HIGH", message: "cyclomatic complexity 22", filePath: "src/big.ts", line: 10 },
      ],
    },
    ragContext: emptyRagContext,
    ...overrides,
  };
}

const architectureSpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "ARCHITECTURE")!;

describe("runAgent", () => {
  it("returns the provider's validated structured output", async () => {
    const provider = createMockAIChatProvider({
      responder: () => ({ summary: "Reasonable modular structure.", findings: [] }),
    });
    const result = await runAgent(architectureSpec, evidenceFixture(), provider);
    expect(result.summary).toBe("Reasonable modular structure.");
    expect(result.findings).toEqual([]);
  });

  it("builds a system prompt containing the guardrails and this agent's own instructions", async () => {
    let seenSystemPrompt = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenSystemPrompt = request.systemPrompt;
        return { summary: "ok", findings: [] };
      },
    });
    await runAgent(architectureSpec, evidenceFixture(), provider);

    expect(seenSystemPrompt).toContain("STATIC ANALYSIS ONLY");
    expect(seenSystemPrompt).toContain("Never invent facts");
    expect(seenSystemPrompt).toContain(architectureSpec.title);
    for (const instruction of architectureSpec.instructions) {
      expect(seenSystemPrompt).toContain(instruction);
    }
  });

  it("includes real deterministic evidence in the user prompt — never invents numbers", async () => {
    let seenUserPrompt = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenUserPrompt = request.userPrompt;
        return { summary: "ok", findings: [] };
      },
    });
    const evidence = evidenceFixture();
    await runAgent(architectureSpec, evidence, provider);

    expect(seenUserPrompt).toContain("acme/widgets");
    expect(seenUserPrompt).toContain("Files analyzed: 42");
    expect(seenUserPrompt).toContain("src/big.ts");
    expect(seenUserPrompt).toContain("COMPLEXITY_HIGH");
  });

  it("includes retrieved RAG chunks with their citations in the user prompt", async () => {
    let seenUserPrompt = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenUserPrompt = request.userPrompt;
        return { summary: "ok", findings: [] };
      },
    });
    const ragContext: RagContext = {
      chunks: [
        {
          chunkId: "c1",
          filePath: "src/router.ts",
          symbolName: "createRouter",
          startLine: 10,
          endLine: 40,
          content: "export function createRouter() { /* ... */ }",
          score: 0.9,
          citation: "src/router.ts:10-40",
        },
      ],
      totalCharacters: 42,
      truncated: 0,
    };
    await runAgent(architectureSpec, evidenceFixture({ ragContext }), provider);

    expect(seenUserPrompt).toContain("src/router.ts:10-40");
    expect(seenUserPrompt).toContain("createRouter");
    expect(seenUserPrompt).toContain("export function createRouter()");
  });

  it("names the JSON schema after the agent type", async () => {
    let seenSchemaName = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenSchemaName = request.schemaName;
        return { summary: "ok", findings: [] };
      },
    });
    await runAgent(architectureSpec, evidenceFixture(), provider);
    expect(seenSchemaName).toBe("architecture_agent_output");
  });

  it("rejects a response with a finding that has no citations — the schema requires at least one", async () => {
    const provider = createMockAIChatProvider({
      responder: () => ({
        summary: "ok",
        findings: [
          {
            category: "coupling",
            title: "Tight coupling",
            summary: "Modules are tightly coupled.",
            severity: "MEDIUM",
            confidence: 0.7,
            evidence: "Multiple modules import each other directly.",
            recommendation: "Introduce an interface boundary.",
            citations: [], // invalid — must have at least one
          },
        ],
      }),
    });
    await expect(runAgent(architectureSpec, evidenceFixture(), provider)).rejects.toThrow();
  });

  it("accepts a well-formed finding with citations", async () => {
    const provider = createMockAIChatProvider({
      responder: () => ({
        summary: "ok",
        findings: [
          {
            category: "coupling",
            title: "Tight coupling",
            summary: "Modules are tightly coupled.",
            severity: "MEDIUM",
            confidence: 0.7,
            evidence: "src/a.ts imports src/b.ts and vice versa.",
            recommendation: "Introduce an interface boundary.",
            citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 5, symbolName: null }],
          },
        ],
      }),
    });
    const result = await runAgent(architectureSpec, evidenceFixture(), provider);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.citations).toHaveLength(1);
  });
});
