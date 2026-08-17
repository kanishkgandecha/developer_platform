"use client";

import { useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, FileCode2, GitBranch, ImportIcon, RefreshCw, ShieldAlert } from "lucide-react";
// Value import from the `/analysis` subpath — see use-analysis-polling.ts's comment.
import { isActiveAnalysisStatus } from "@developer-platform/shared/analysis";
import type { AnalysisRunDto, IngestionDto } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAnalysisPolling } from "@/hooks/use-analysis-polling";
import { AnalysisStatusBadge } from "./analysis-status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const STAGE_DESCRIPTION: Record<string, string> = {
  PENDING: "Queued for analysis…",
  QUEUED: "Queued for analysis…",
  PARSING: "Retrieving the repository and parsing source files…",
  INDEXING: "Persisting symbols, imports, and metrics…",
  ANALYZING: "Building the dependency graph…",
};

const SEVERITY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const;
const SEVERITY_CLASS: Record<(typeof SEVERITY_ORDER)[number], string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-destructive",
  MEDIUM: "text-warning",
  LOW: "text-muted-foreground",
  INFO: "text-muted-foreground",
};

function Stat({ icon: Icon, label, value }: { icon?: LucideIcon; label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

interface StartAnalysisResponse {
  id?: string;
  analysis?: { id: string };
  error?: { message?: string };
}

export function AnalysisPanel({
  repositoryId,
  ingestion,
}: {
  repositoryId: string;
  /** The repository's latest ingestion — analysis can't start until it's COMPLETED, and its `latestAnalysis` seeds the initial view. */
  ingestion: IngestionDto | null;
}) {
  const [pollId, setPollId] = useState<string | null>(ingestion?.latestAnalysis?.id ?? null);
  const analysis: AnalysisRunDto | null = useAnalysisPolling(pollId, ingestion?.latestAnalysis ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = analysis ? isActiveAnalysisStatus(analysis.status) : false;
  const ingestionReady = ingestion?.status === "COMPLETED";

  async function handleAnalyze() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${repositoryId}/analyses`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as StartAnalysisResponse | null;

      if ((response.status === 201 || response.status === 200) && body?.id) {
        setPollId(body.id);
      } else if (response.status === 409 && body?.analysis) {
        setPollId(body.analysis.id);
      } else {
        setError(body?.error?.message ?? "Couldn't start analysis — try again.");
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
          <CardTitle>Code Intelligence</CardTitle>
          <AnalysisStatusBadge status={analysis?.status ?? null} />
        </div>
        <CardDescription>
          {!ingestionReady
            ? "Analyze the repository first to unlock code intelligence — symbols, imports, a dependency graph, and deterministic findings, no AI involved."
            : analysis
              ? "Deterministic static analysis: parsed symbols, resolved imports, and rule-based findings."
              : "Not analyzed yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t start analysis</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {active && analysis && (
          <div className="flex items-center gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" />
            {STAGE_DESCRIPTION[analysis.status] ?? analysis.status}
          </div>
        )}

        {analysis?.status === "COMPLETED" && (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 sm:grid-cols-4">
              <Stat icon={FileCode2} label="Files analyzed" value={analysis.filesAnalyzed ?? 0} />
              <Stat icon={GitBranch} label="Symbols found" value={analysis.symbolsFound ?? 0} />
              <Stat icon={ImportIcon} label="Imports found" value={analysis.importsFound ?? 0} />
              <Stat icon={ShieldAlert} label="Findings" value={analysis.findingsCount ?? 0} />
            </div>

            {analysis.severityCounts && (
              <div className="flex flex-wrap items-center gap-3 text-xs">
                {SEVERITY_ORDER.map((severity) => (
                  <span key={severity} className={SEVERITY_CLASS[severity]}>
                    {severity[0]}
                    {severity.slice(1).toLowerCase()} {analysis.severityCounts![severity]}
                  </span>
                ))}
              </div>
            )}

            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/repositories/${repositoryId}/analyses/${analysis.id}`} />}
              className="w-fit gap-1.5"
            >
              View findings &amp; code explorer
              <ArrowRight className="size-3.5" />
            </Button>
          </>
        )}

        {analysis?.status === "FAILED" && analysis.error && (
          <Alert variant="destructive">
            <AlertTitle>Analysis failed</AlertTitle>
            <AlertDescription>{analysis.error}</AlertDescription>
          </Alert>
        )}

        <Button
          onClick={handleAnalyze}
          disabled={starting || active || !ingestionReady}
          className="w-fit gap-1.5"
        >
          <RefreshCw className={starting || active ? "size-3.5 animate-spin" : "size-3.5"} />
          {active ? "Analyzing Code…" : analysis ? "Re-run Code Analysis" : "Analyze Code"}
        </Button>
      </CardContent>
    </Card>
  );
}
