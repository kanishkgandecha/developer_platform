"use client";

import { useState } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ArrowRight, Layers, RefreshCw, Search, Sparkles } from "lucide-react";
// Value import from the `/embedding` subpath — see use-embedding-polling.ts's comment.
import { isActiveEmbeddingStatus } from "@developer-platform/shared/embedding";
import type { AnalysisRunDto, EmbeddingRunDto } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useEmbeddingPolling } from "@/hooks/use-embedding-polling";
import { EmbeddingStatusBadge } from "./embedding-status-badge";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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

interface StartEmbeddingResponse {
  id?: string;
  embedding?: { id: string };
  error?: { message?: string };
}

export function EmbeddingPanel({
  repositoryId,
  analysis,
  initialEmbedding,
}: {
  repositoryId: string;
  /** The repository's latest analysis run — indexing can't start until it's COMPLETED. */
  analysis: AnalysisRunDto | null;
  initialEmbedding: EmbeddingRunDto | null;
}) {
  const [pollId, setPollId] = useState<string | null>(initialEmbedding?.id ?? null);
  const embedding: EmbeddingRunDto | null = useEmbeddingPolling(pollId, initialEmbedding);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = embedding ? isActiveEmbeddingStatus(embedding.status) : false;
  const analysisReady = analysis?.status === "COMPLETED";

  const discovered = embedding?.chunksDiscovered ?? 0;
  const embedded = embedding?.chunksEmbedded ?? 0;
  const reused = embedding?.chunksReused ?? 0;
  const indexedSoFar = embedded + reused;
  // Real, persisted progress only — never simulated. `chunksDiscovered` is
  // written by the worker as soon as the diff is known (before any
  // embedding call), so this ratio is a true denominator from the start.
  const progressPct = discovered > 0 ? Math.min(100, Math.round((indexedSoFar / discovered) * 100)) : 0;

  async function handleIndex() {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${repositoryId}/embeddings`, {
        method: "POST",
        credentials: "include",
      });
      const body = (await response.json().catch(() => null)) as StartEmbeddingResponse | null;

      if ((response.status === 201 || response.status === 200) && body?.id) {
        setPollId(body.id);
      } else if (response.status === 409 && body?.embedding) {
        setPollId(body.embedding.id);
      } else if (response.status === 503) {
        setError(body?.error?.message ?? "Semantic search is not configured on this server.");
      } else {
        setError(body?.error?.message ?? "Couldn't start indexing — try again.");
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
          <CardTitle>Semantic Index</CardTitle>
          <EmbeddingStatusBadge status={embedding?.status ?? null} />
        </div>
        <CardDescription>
          {!analysisReady
            ? "Run code analysis first to unlock semantic search — chunking and embedding build on top of parsed symbols."
            : embedding
              ? "Deterministic chunking, batched embedding, and repository-scoped vector search — retrieval only, no chat, no AI-generated summaries."
              : "Not indexed yet."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t start indexing</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {active && embedding && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <RefreshCw className="size-3.5 animate-spin" />
              {embedding.status === "EMBEDDING" ? "Embedding repository…" : "Queued for indexing…"}
            </div>
            {discovered > 0 && (
              <>
                <Progress value={progressPct} />
                <p className="text-xs text-muted-foreground">
                  {indexedSoFar} / {discovered} chunks ({reused} reused, {embedded} embedded)
                </p>
              </>
            )}
          </div>
        )}

        {embedding?.status === "COMPLETED" && (
          <>
            <div className="grid grid-cols-2 gap-4 rounded-lg border border-border p-4 sm:grid-cols-4">
              <Stat icon={Layers} label="Chunks" value={discovered} />
              <Stat icon={Sparkles} label="Embedded" value={embedded} />
              <Stat label="Reused" value={reused} />
              <Stat
                label="Last indexed"
                value={embedding.completedAt ? new Date(embedding.completedAt).toLocaleDateString() : "—"}
              />
            </div>

            <Button
              variant="outline"
              nativeButton={false}
              render={<Link href={`/repositories/${repositoryId}/search`} />}
              className="w-fit gap-1.5"
            >
              <Search className="size-3.5" />
              Search this repository
              <ArrowRight className="size-3.5" />
            </Button>
          </>
        )}

        {embedding?.status === "FAILED" && embedding.error && (
          <Alert variant="destructive">
            <AlertTitle>Indexing failed</AlertTitle>
            <AlertDescription>{embedding.error}</AlertDescription>
          </Alert>
        )}

        <Button onClick={handleIndex} disabled={starting || active || !analysisReady} className="w-fit gap-1.5">
          <RefreshCw className={starting || active ? "size-3.5 animate-spin" : "size-3.5"} />
          {active ? "Indexing…" : embedding ? "Re-index Repository" : "Index Repository"}
        </Button>
      </CardContent>
    </Card>
  );
}
