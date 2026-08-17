import { describe, expect, it } from "vitest";
import { createMockAIChatProvider } from "../chat/mock-provider.js";
import { runExecutiveSummaryAgent } from "./executive-summary.js";
import { PRIMARY_AGENT_SPECS } from "./specs.js";
import type { AgentFinding } from "./schemas.js";
import type { AgentRunResult } from "./types.js";

function finding(overrides: Partial<AgentFinding> = {}): AgentFinding {
  return {
    category: "coupling",
    title: "Tight coupling",
    summary: "Modules are tightly coupled.",
    severity: "MEDIUM",
    confidence: 0.7,
    evidence: "src/a.ts imports src/b.ts and vice versa.",
    recommendation: "Introduce an interface boundary.",
    citations: [{ filePath: "src/a.ts", startLine: 1, endLine: 5, symbolName: null }],
    ...overrides,
  };
}

const architectureSpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "ARCHITECTURE")!;
const securitySpec = PRIMARY_AGENT_SPECS.find((s) => s.type === "SECURITY")!;

describe("runExecutiveSummaryAgent", () => {
  it("returns a validated executive summary", async () => {
    const results: AgentRunResult[] = [
      { spec: architectureSpec, output: { summary: "Modular, some coupling risk.", findings: [finding()] } },
    ];
    const provider = createMockAIChatProvider({
      responder: () => ({
        overallHealth: "GOOD",
        summary: "The repository is generally healthy with some coupling risk.",
        strengths: ["Clear module boundaries in most areas"],
        topRisks: [finding()],
        recommendedNextSteps: ["Introduce an interface boundary between src/a.ts and src/b.ts"],
      }),
    });

    const summary = await runExecutiveSummaryAgent(results, provider);
    expect(summary.overallHealth).toBe("GOOD");
    expect(summary.topRisks).toHaveLength(1);
  });

  it("includes every underlying agent's summary and findings in the prompt", async () => {
    const results: AgentRunResult[] = [
      { spec: architectureSpec, output: { summary: "Architecture summary text", findings: [finding({ title: "Arch finding" })] } },
      { spec: securitySpec, output: { summary: "Security summary text", findings: [finding({ title: "Security finding", category: "secrets" })] } },
    ];
    let seenUserPrompt = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenUserPrompt = request.userPrompt;
        return { overallHealth: "GOOD", summary: "ok", strengths: [], topRisks: [], recommendedNextSteps: [] };
      },
    });

    await runExecutiveSummaryAgent(results, provider);

    expect(seenUserPrompt).toContain("Architecture summary text");
    expect(seenUserPrompt).toContain("Security summary text");
    expect(seenUserPrompt).toContain("Arch finding");
    expect(seenUserPrompt).toContain("Security finding");
  });

  it("still synthesizes a summary from fewer than six agents (partial-failure tolerance)", async () => {
    const results: AgentRunResult[] = [{ spec: architectureSpec, output: { summary: "Only architecture ran.", findings: [] } }];
    const provider = createMockAIChatProvider({
      responder: () => ({ overallHealth: "FAIR", summary: "Limited data available.", strengths: [], topRisks: [], recommendedNextSteps: [] }),
    });

    const summary = await runExecutiveSummaryAgent(results, provider);
    expect(summary.summary).toBe("Limited data available.");
  });

  it("instructs the model to reuse (not invent) citations for topRisks", async () => {
    let seenSystemPrompt = "";
    const provider = createMockAIChatProvider({
      responder: (request) => {
        seenSystemPrompt = request.systemPrompt;
        return { overallHealth: "GOOD", summary: "ok", strengths: [], topRisks: [], recommendedNextSteps: [] };
      },
    });
    await runExecutiveSummaryAgent([{ spec: architectureSpec, output: { summary: "s", findings: [] } }], provider);
    expect(seenSystemPrompt).toMatch(/never invent a new citation/i);
  });
});
