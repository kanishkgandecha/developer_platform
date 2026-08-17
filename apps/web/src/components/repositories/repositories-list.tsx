"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { ExternalLink, FolderGit2, Lock, RefreshCw, Search, Trash2 } from "lucide-react";
import type { RepositoryDto } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-states/empty-state";
import { IngestionStatusBadge } from "@/components/ingestion/ingestion-status-badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface ApiErrorBody {
  error?: { message?: string };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ApiErrorBody;
    return body.error?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function RepositoriesList({ initialRepositories }: { initialRepositories: RepositoryDto[] }) {
  const [repositories, setRepositories] = useState(initialRepositories);
  const [query, setQuery] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reduceMotion = useReducedMotion();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return repositories;
    return repositories.filter(
      (repo) => repo.fullName.toLowerCase().includes(q) || repo.description?.toLowerCase().includes(q),
    );
  }, [repositories, query]);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/connect`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) {
        setError(await readErrorMessage(response, "Couldn't sync repositories from GitHub."));
        return;
      }
      const { repositories: synced } = (await response.json()) as { repositories: RepositoryDto[] };
      setRepositories(synced);
    } catch {
      setError("Couldn't reach the API to sync repositories — check your connection and try again.");
    } finally {
      setSyncing(false);
    }
  }

  async function handleRemove(id: string) {
    setRemovingId(id);
    setError(null);
    try {
      const response = await fetch(`${API_URL}/repositories/${id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok && response.status !== 404) {
        setError(await readErrorMessage(response, "Couldn't remove that repository."));
        return;
      }
      setRepositories((current) => current.filter((repo) => repo.id !== id));
    } catch {
      setError("Couldn't reach the API to remove that repository — check your connection and try again.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search repositories"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
            aria-label="Search repositories"
          />
        </div>
        <Button onClick={handleSync} disabled={syncing} variant="outline" size="sm" className="gap-1.5">
          <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
          {syncing ? "Syncing…" : "Sync from GitHub"}
        </Button>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {repositories.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No repositories connected"
          description="Sync your GitHub account to see the repositories you have access to."
          action={
            <Button size="sm" onClick={handleSync} disabled={syncing} className="gap-1.5">
              <RefreshCw className={syncing ? "size-3.5 animate-spin" : "size-3.5"} />
              {syncing ? "Syncing…" : "Sync from GitHub"}
            </Button>
          }
        />
      ) : filtered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
          No repositories match &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Repository</TableHead>
                <TableHead>Visibility</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Default branch</TableHead>
                <TableHead className="w-0" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence initial={false}>
                {filtered.map((repo) => (
                  <motion.tr
                    key={repo.id}
                    layout={!reduceMotion}
                    initial={reduceMotion ? undefined : { opacity: 0 }}
                    animate={reduceMotion ? undefined : { opacity: 1 }}
                    exit={reduceMotion ? undefined : { opacity: 0 }}
                    className="border-b border-border transition-colors last:border-0 hover:bg-muted/40 data-[state=selected]:bg-muted"
                  >
                    <TableCell>
                      <div className="flex flex-col gap-0.5">
                        <div className="flex w-fit items-center gap-1.5">
                          <Link
                            href={`/repositories/${repo.id}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {repo.fullName}
                          </Link>
                          <a
                            href={repo.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`View ${repo.fullName} on GitHub`}
                            className="text-muted-foreground hover:text-foreground"
                          >
                            <ExternalLink className="size-3" />
                          </a>
                        </div>
                        {repo.description && (
                          <span className="max-w-md truncate text-xs text-muted-foreground">
                            {repo.description}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={repo.private ? "outline" : "secondary"} className="gap-1">
                        {repo.private && <Lock className="size-3" />}
                        {repo.private ? "Private" : "Public"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <IngestionStatusBadge status={repo.latestIngestion?.status ?? null} />
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground md:table-cell">
                      {repo.defaultBranch}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${repo.fullName}`}
                        disabled={removingId === repo.id}
                        onClick={() => handleRemove(repo.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </TableCell>
                  </motion.tr>
                ))}
              </AnimatePresence>
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

/** Row-count skeleton shown while the page itself is loading — see loading.tsx. */
export function RepositoriesListSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
