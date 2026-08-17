"use client";

import { useState } from "react";
import type { LucideIcon } from "lucide-react";
import { FileCode2, FileText, GitCommitHorizontal, RefreshCw } from "lucide-react";
// Value import from the `/ingestion` subpath — see apps/web/src/lib/api.ts's
// comment on the Turbopack barrel value-export bug this sidesteps.
import { isActiveIngestionStatus } from "@developer-platform/shared/ingestion";
import type { IngestionDto } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useIngestionPolling } from "@/hooks/use-ingestion-polling";
import { IngestionStatusBadge } from "./ingestion-status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const STAGE_DESCRIPTION: Record<string, string> = {
  PENDING: "Queued for processing…",
  QUEUED: "Queued for processing…",
  RETRIEVING: "Retrieving repository from GitHub…",
  EXTRACTING: "Extracting repository archive…",
  SCANNING: "Scanning and classifying source files…",
};

function Stat({ icon: Icon, label, value, mono }: { icon?: LucideIcon; label: string; value: string | number; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {label}
      </span>
      <span className={mono ? "font-mono text-sm" : "text-sm font-medium"}>{value}</span>
    </div>
  );
}

interface StartIngestionResponse {
  id?: string;
  ingestion?: { id: string };
  error?: { message?: string };
}

export function IngestionPanel({
  repositoryId,
  initialIngestion,
}: {
  repositoryId: string;
  initialIngestion: IngestionDto | null;
}) {
  const [pollId, setPollId] = useState<string | null>(initialIngestion?.id ?? null);
  const ingestion = useIngestionPolling(pollId, initialIngestion);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = ingestion ? isActiveIngestionStatus(ingestion.status) : false;

  async function handleAnalyze() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${repositoryId}/ingestions`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as StartIngestionResponse | null;

      if ((response.status === 201 || response.status === 200) && body?.id) {
        setPollId(body.id);
      } else if (response.status === 409 && body?.ingestion) {
        // Someone (this tab, another tab, a retry) already has one running
        // for this commit — start watching that one instead of erroring.
        setPollId(body.ingestion.id);
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
          {/* "Ingestion", not "Analysis" — Phase 4 introduces a real, separate Code Intelligence analysis step below, and reusing this word for both was confusing. */}
          <CardTitle>Repository Ingestion</CardTitle>
          <IngestionStatusBadge status={ingestion?.status ?? null} />
        </div>
        <CardDescription>
          {ingestion
            ? `Commit ${ingestion.commitSha.slice(0, 7)}`
            : "Not ingested yet — this only discovers and classifies files, no code is executed."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t start analysis</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {active && ingestion && (
          <div className="flex flex-col gap-2">
            <Progress value={ingestion.progress} />
            <p className="text-xs text-muted-foreground">{STAGE_DESCRIPTION[ingestion.status] ?? ingestion.status}</p>
          </div>
        )}

        {ingestion?.status === "COMPLETED" && (
          <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 sm:grid-cols-4">
            <Stat icon={FileText} label="Files discovered" value={ingestion.fileCount ?? 0} />
            <Stat icon={FileCode2} label="Source files" value={ingestion.sourceFileCount ?? 0} />
            <Stat icon={GitCommitHorizontal} label="Commit" value={ingestion.commitSha.slice(0, 7)} mono />
            <Stat
              label="Completed"
              value={ingestion.completedAt ? new Date(ingestion.completedAt).toLocaleString() : "—"}
            />
          </div>
        )}

        {ingestion?.status === "FAILED" && ingestion.error && (
          <Alert variant="destructive">
            <AlertTitle>Ingestion failed</AlertTitle>
            <AlertDescription>{ingestion.error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={handleAnalyze} disabled={starting || active} className="w-fit gap-1.5">
          <RefreshCw className={starting || active ? "size-3.5 animate-spin" : "size-3.5"} />
          {active ? "Analyzing…" : ingestion ? "Re-analyze Repository" : "Analyze Repository"}
        </Button>
      </CardContent>
    </Card>
  );
}
