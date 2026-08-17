"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Bot, RefreshCw, ShieldAlert, Sparkles } from "lucide-react";
// Value import from the `/ai-analysis` subpath — see use-ai-analysis-polling.ts's comment.
import { isActiveAIAnalysisStatus } from "@developer-platform/shared/ai-analysis";
import type { AIAnalysisRunDto, EmbeddingRunDto } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useAIAnalysisPolling } from "@/hooks/use-ai-analysis-polling";
import { AIAnalysisStatusBadge } from "./ai-analysis-status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface StartAIAnalysisResponse {
  id?: string;
  aiAnalysis?: { id: string };
  error?: { message?: string };
}

export function AIAnalysisPanel({
  repositoryId,
  embedding,
  initialAIAnalysis,
}: {
  repositoryId: string;
  /** The repository's latest embedding run — AI analysis can't start until it's COMPLETED (semantic search is a required input for every agent). */
  embedding: EmbeddingRunDto | null;
  initialAIAnalysis: AIAnalysisRunDto | null;
}) {
  const [pollId, setPollId] = useState<string | null>(initialAIAnalysis?.id ?? null);
  const aiAnalysis: AIAnalysisRunDto | null = useAIAnalysisPolling(pollId, initialAIAnalysis);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = aiAnalysis ? isActiveAIAnalysisStatus(aiAnalysis.status) : false;
  const embeddingReady = embedding?.status === "COMPLETED";

  const totalAgents = aiAnalysis?.agents.length ?? 0;
  const completedAgents = aiAnalysis?.agents.filter((a) => a.status === "COMPLETED").length ?? 0;
  const progressPct = totalAgents > 0 ? Math.round((completedAgents / totalAgents) * 100) : 0;
  const currentAgent = aiAnalysis?.agents.find((a) => a.status === "RUNNING");

  async function handleRun() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${repositoryId}/ai-analysis`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as StartAIAnalysisResponse | null;

      if ((response.status === 201 || response.status === 200) && body?.id) {
        setPollId(body.id);
      } else if (response.status === 409 && body?.aiAnalysis) {
        setPollId(body.aiAnalysis.id);
      } else if (response.status === 503) {
        setError(body?.error?.message ?? "AI analysis requires an OpenAI API key to be configured on this server.");
      } else {
        setError(body?.error?.message ?? "Couldn't start AI analysis — try again.");
      }
    } catch {
      setError("Couldn't reach the API — check your connection and try again.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-1.5">
            <Bot className="size-4" />
            AI Analysis
          </CardTitle>
          <AIAnalysisStatusBadge status={aiAnalysis?.status ?? null} />
        </div>
        <CardDescription>
          {!embeddingReady
            ? "Index the repository for semantic search first — every agent grounds its analysis in retrieved code, not just a raw prompt."
            : aiAnalysis
              ? "Seven specialized agents interpret the deterministic findings and indexed code above — every finding is evidence-backed and cites real files and lines."
              : "Not run yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Couldn&apos;t start AI analysis</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {active && aiAnalysis && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="size-3.5 animate-spin" />
              {currentAgent ? `Running ${currentAgent.agent.replaceAll("_", " ").toLowerCase()} agent…` : "Starting agents…"}
            </div>
            {totalAgents > 0 && (
              <>
                <Progress value={progressPct} />
                <p className="text-xs text-muted-foreground">{completedAgents} / {totalAgents} agents complete</p>
              </>
            )}
          </div>
        )}

        {(aiAnalysis?.status === "COMPLETED" || aiAnalysis?.status === "COMPLETED_WITH_WARNINGS") && (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 sm:grid-cols-4">
              <div className="flex flex-col gap-1">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Sparkles className="size-3.5" />
                  Agents completed
                </span>
                <span className="text-sm font-medium">{completedAgents} / {totalAgents}</span>
              </div>
              {aiAnalysis.severityCounts && (
                <div className="flex flex-col gap-1">
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <ShieldAlert className="size-3.5" />
                    Findings
                  </span>
                  <span className="text-sm font-medium">
                    {Object.values(aiAnalysis.severityCounts).reduce((a, b) => a + b, 0)}
                  </span>
                </div>
              )}
            </div>

            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/repositories/${repositoryId}/ai-analysis/${aiAnalysis.id}`} />}
              className="w-fit gap-1.5"
            >
              View AI analysis
              <ArrowRight className="size-3.5" />
            </Button>
          </>
        )}

        {aiAnalysis?.status === "FAILED" && aiAnalysis.error && (
          <Alert variant="destructive">
            <AlertTitle>AI analysis failed</AlertTitle>
            <AlertDescription>{aiAnalysis.error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={handleRun} disabled={starting || active || !embeddingReady} className="w-fit gap-1.5">
          <RefreshCw className={starting || active ? "size-3.5 animate-spin" : "size-3.5"} />
          {active ? "Running…" : aiAnalysis ? "Re-run AI Analysis" : "Run AI Analysis"}
        </Button>
      </CardContent>
    </Card>
  );
}
