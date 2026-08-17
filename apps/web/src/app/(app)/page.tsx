import Link from "next/link";
import { FolderGit2 } from "lucide-react";
import type { RepositoryDto } from "@developer-platform/shared";
import { AbstractBackground } from "@/components/motion/abstract-background";
import { Reveal } from "@/components/motion/reveal";
import { EmptyState } from "@/components/empty-states/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getRepositories(): Promise<RepositoryDto[]> {
  const response = await serverFetch("/repositories");
  if (!response.ok) {
    return [];
  }
  const { repositories } = (await response.json()) as { repositories: RepositoryDto[] };
  return repositories;
}

/**
 * Aggregate, honest counts derived entirely from the fields `GET
 * /repositories` already returns (`latestIngestion`/`latestAnalysis`
 * embedded per row) — no extra per-repository requests. Deliberately
 * limited to what's already on that response: adding embedding/AI-analysis
 * status here would mean an N+1 fan-out across every repository just to
 * populate a dashboard summary.
 */
function summarize(repositories: RepositoryDto[]) {
  const ingestedCount = repositories.filter((r) => r.latestIngestion?.status === "COMPLETED").length;
  const analyzedRepos = repositories.filter((r) => r.latestIngestion?.latestAnalysis?.status === "COMPLETED");
  const totalFindings = analyzedRepos.reduce(
    (sum, r) => sum + (r.latestIngestion?.latestAnalysis?.findingsCount ?? 0),
    0,
  );
  return { ingestedCount, analyzedCount: analyzedRepos.length, totalFindings };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const repositories = await getRepositories();
  const repositoryCount = repositories.length;
  const { ingestedCount, analyzedCount, totalFindings } = summarize(repositories);

  return (
    <div className="flex flex-col gap-10">
      <Reveal>
        <div className="relative overflow-hidden rounded-xl border border-border px-5 py-10 sm:px-8 sm:py-14">
          <AbstractBackground />
          <div className="relative flex flex-col gap-4">
            <Badge variant="outline" className="w-fit text-muted-foreground">
              Welcome back, {user.githubUsername}
            </Badge>
            <h1 className="max-w-xl text-3xl font-semibold tracking-tight text-balance md:text-4xl">
              Understand your codebase. Find risks. Improve architecture.
            </h1>
            <p className="max-w-lg text-sm text-muted-foreground md:text-base">
              Connect a GitHub repository and get an evidence-backed engineering
              analysis — architecture, security, code quality, testing, dependencies, and
              documentation — plus semantic code search across the indexed source.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Button nativeButton={false} render={<Link href="/repositories" />}>
                {repositoryCount > 0 ? "View repositories" : "Connect repositories"}
              </Button>
              <Button variant="outline" nativeButton={false} render={<Link href="/status" />}>
                View system status
              </Button>
            </div>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.08}>
        <Card>
          <CardHeader>
            <CardTitle>Engineering Health</CardTitle>
            <CardDescription>
              Appears once a repository has been analyzed. Scores are always derived from
              real findings — never generated without evidence.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {repositoryCount > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div>
                  <p className="text-2xl font-semibold tracking-tight">{repositoryCount}</p>
                  <p className="text-xs text-muted-foreground">
                    {repositoryCount === 1 ? "Repository" : "Repositories"} connected
                  </p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tracking-tight">{ingestedCount}</p>
                  <p className="text-xs text-muted-foreground">Ingested</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tracking-tight">{analyzedCount}</p>
                  <p className="text-xs text-muted-foreground">Analyzed</p>
                </div>
                <div>
                  <p className="text-2xl font-semibold tracking-tight">{totalFindings}</p>
                  <p className="text-xs text-muted-foreground">Findings from code analysis</p>
                </div>
              </div>
            ) : (
              <EmptyState
                icon={FolderGit2}
                title="No repositories yet"
                description="Connect your GitHub account to access repositories you can analyze."
                action={
                  <Button size="sm" nativeButton={false} render={<Link href="/repositories" />}>
                    Connect GitHub
                  </Button>
                }
              />
            )}
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
