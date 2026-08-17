import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock } from "lucide-react";
import type { AgentRunDto, AIAnalysisRunDto } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AIAnalysisStatusBadge } from "@/components/ai-analysis/ai-analysis-status-badge";
import { AgentCards } from "@/components/ai-analysis/agent-cards";
import { AIFindingsExplorer } from "@/components/ai-analysis/ai-findings-explorer";
import { EmptyState } from "@/components/empty-states/empty-state";
import { Reveal } from "@/components/motion/reveal";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getAIAnalysis(id: string): Promise<AIAnalysisRunDto | null> {
  const response = await serverFetch(`/ai-analysis/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /ai-analysis/${id} failed with HTTP ${response.status}`);
  return (await response.json()) as AIAnalysisRunDto;
}

async function getAgents(id: string): Promise<AgentRunDto[]> {
  const response = await serverFetch(`/ai-analysis/${id}/agents`);
  if (!response.ok) return [];
  const body = (await response.json()) as { agents: AgentRunDto[] };
  return body.agents;
}

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;

export default async function AIAnalysisDetailPage({ params }: PageProps<"/repositories/[id]/ai-analysis/[analysisId]">) {
  await requireUser();
  const { id, analysisId } = await params;

  const [aiAnalysis, agents] = await Promise.all([getAIAnalysis(analysisId), getAgents(analysisId)]);
  if (!aiAnalysis) {
    notFound();
  }

  const executiveSummary = agents.find((a) => a.agent === "EXECUTIVE_SUMMARY");
  const isTerminal = aiAnalysis.status === "COMPLETED" || aiAnalysis.status === "COMPLETED_WITH_WARNINGS";

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <div className="flex flex-col gap-2">
          <Link href={`/repositories/${id}`} className="w-fit text-xs text-muted-foreground hover:underline">
            &larr; Repository
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">AI Analysis</h1>
            <AIAnalysisStatusBadge status={aiAnalysis.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Seven specialized agents interpreting Phase 4&apos;s deterministic findings and Phase 5&apos;s indexed
            code — every finding cites the real file/line evidence it was grounded in.
          </p>
        </div>
      </Reveal>

      {!isTerminal && aiAnalysis.status !== "FAILED" && (
        <Reveal delay={0.06}>
          <EmptyState
            icon={Clock}
            title="Still running"
            description="This analysis hasn't finished yet — go back to the repository page for live progress, or refresh this page shortly."
          />
        </Reveal>
      )}

      {aiAnalysis.status === "FAILED" && (
        <Reveal delay={0.06}>
          <EmptyState icon={Clock} title="AI analysis failed" description={aiAnalysis.error ?? "AI analysis failed unexpectedly."} />
        </Reveal>
      )}

      {isTerminal && (
        <>
          {executiveSummary?.summary && (
            <Reveal delay={0.06}>
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Executive Summary</CardTitle>
                  <CardDescription>Synthesized from the six specialized agents below — not a simple concatenation.</CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm text-foreground">{executiveSummary.summary}</p>
                  {aiAnalysis.severityCounts && (
                    <div className="flex flex-wrap gap-2">
                      {SEVERITY_ORDER.map((severity) => (
                        <Badge key={severity} variant="outline" className="gap-1">
                          {severity}
                          <span className="font-mono">{aiAnalysis.severityCounts![severity]}</span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </Reveal>
          )}

          <Reveal delay={0.1}>
            <div className="flex flex-col gap-3">
              <h2 className="text-sm font-medium text-foreground">Agents</h2>
              <AgentCards agents={agents} />
            </div>
          </Reveal>

          <Reveal delay={0.14}>
            <AIFindingsExplorer aiAnalysisId={aiAnalysis.id} />
          </Reveal>
        </>
      )}
    </div>
  );
}
