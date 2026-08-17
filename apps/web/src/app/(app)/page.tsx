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

async function getRepositoryCount(): Promise<number> {
  const response = await serverFetch("/repositories");
  if (!response.ok) {
    return 0;
  }
  const { repositories } = (await response.json()) as { repositories: RepositoryDto[] };
  return repositories.length;
}

export default async function DashboardPage() {
  const user = await requireUser();
  const repositoryCount = await getRepositoryCount();

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
              documentation, with a repository assistant to ask questions against it.
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
              <p className="text-sm text-muted-foreground">
                {repositoryCount} {repositoryCount === 1 ? "repository" : "repositories"}{" "}
                connected. Analysis is not implemented yet — repository ingestion and the AI
                agents land in later phases.
              </p>
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
