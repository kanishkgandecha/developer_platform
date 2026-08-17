"use client";

import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Clock, FileCode2, Search, SearchX } from "lucide-react";
import type { RetrievalResultDto, SemanticSearchResponse, SemanticSearchStatus } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/empty-states/empty-state";
import { Reveal } from "@/components/motion/reveal";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

function scoreColor(score: number): string {
  if (score >= 0.85) return "text-success";
  if (score >= 0.65) return "text-warning";
  return "text-muted-foreground";
}

function ResultRow({ result, index }: { result: RetrievalResultDto; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const lines =
    result.startLine !== null && result.endLine !== null
      ? result.startLine === result.endLine
        ? `line ${result.startLine}`
        : `lines ${result.startLine}–${result.endLine}`
      : null;

  return (
    <Reveal delay={index * 0.03}>
      <div className="overflow-hidden rounded-lg border border-border">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-muted/40"
        >
          <div className="flex items-center gap-3">
            <span className={cn("shrink-0 font-mono text-sm font-semibold tabular-nums", scoreColor(result.finalScore))}>
              {result.finalScore.toFixed(2)}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground">{result.filePath}</span>
            {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-[3.25rem] text-xs text-muted-foreground">
            {result.symbolName && (
              <Badge variant="outline" className="font-mono text-[10px]">
                {result.symbolName}()
              </Badge>
            )}
            {lines && <span>{lines}</span>}
            <Badge variant="secondary" className="text-[10px]">
              {result.language}
            </Badge>
          </div>
        </button>

        {expanded && (
          <div className="border-t border-border bg-muted/20 p-4">
            <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <span>semantic {result.semanticScore.toFixed(3)}</span>
              <span>lexical {result.lexicalScore === null ? "—" : result.lexicalScore.toFixed(3)}</span>
              <span>final {result.finalScore.toFixed(3)}</span>
            </div>
            <pre className="overflow-x-auto rounded-md bg-background p-3 font-mono text-xs leading-relaxed text-foreground">
              <code>{result.content}</code>
            </pre>
          </div>
        )}
      </div>
    </Reveal>
  );
}

const STATUS_EMPTY_STATE: Record<Exclude<SemanticSearchStatus, "ready">, { icon: typeof SearchX; title: string; description: string }> = {
  not_configured: {
    icon: AlertTriangle,
    title: "Semantic search is not configured",
    description: "This server doesn't have an embedding provider configured (OPENAI_API_KEY is not set). Ask an administrator to configure it.",
  },
  not_indexed: {
    icon: SearchX,
    title: "This repository hasn't been indexed yet",
    description: "Run code analysis, then index the repository from its detail page to enable semantic search.",
  },
  indexing: {
    icon: Clock,
    title: "Indexing in progress",
    description: "This repository's semantic index is still being built. Search will be available once indexing completes.",
  },
};

/** Repository-scoped semantic (+ lexical) code search — retrieval only, no chat, no AI-generated answers. See docs/semantic-search.md. */
export function SemanticSearch({ repositoryId }: { repositoryId: string }) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState<string | null>(null);
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [results, setResults] = useState<RetrievalResultDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${repositoryId}/search`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: trimmed, limit: 10 }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Search failed — try again.");
        setStatus(null);
        setResults([]);
        return;
      }
      const body = (await response.json()) as SemanticSearchResponse;
      setStatus(body.status);
      setResults(body.results);
      setSubmittedQuery(trimmed);
    } catch {
      setError("Couldn't reach the API — check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search this repository… e.g. “How is GitHub OAuth state validated?”"
                className="h-10 pl-8"
              />
            </div>
            <Button type="submit" disabled={loading || query.trim().length === 0}>
              {loading ? "Searching…" : "Search"}
            </Button>
          </form>
        </CardHeader>
      </Card>

      {error && (
        <EmptyState icon={AlertTriangle} title="Search failed" description={error} />
      )}

      {!error && status && status !== "ready" && (
        <EmptyState
          icon={STATUS_EMPTY_STATE[status].icon}
          title={STATUS_EMPTY_STATE[status].title}
          description={STATUS_EMPTY_STATE[status].description}
        />
      )}

      {!error && status === "ready" && results.length === 0 && (
        <EmptyState
          icon={SearchX}
          title="No results"
          description={`No chunks matched “${submittedQuery}” in this repository.`}
        />
      )}

      {!error && status === "ready" && results.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">
            {results.length} result{results.length === 1 ? "" : "s"} for &ldquo;{submittedQuery}&rdquo;
          </p>
          {results.map((result, index) => (
            <ResultRow key={result.chunkId} result={result} index={index} />
          ))}
        </div>
      )}

      {!error && status === null && (
        <EmptyState
          icon={FileCode2}
          title="Search this repository"
          description="Ask a question about the codebase, or search for a function, class, or file by name."
        />
      )}
    </div>
  );
}
