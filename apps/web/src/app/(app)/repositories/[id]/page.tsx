import Link from "next/link";
import { notFound } from "next/navigation";
import { ExternalLink, Lock } from "lucide-react";
import type { RepositoryDto } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { AnalysisPanel } from "@/components/analysis/analysis-panel";
import { IngestionPanel } from "@/components/ingestion/ingestion-panel";
import { Reveal } from "@/components/motion/reveal";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getRepository(id: string): Promise<RepositoryDto | null> {
  const response = await serverFetch(`/repositories/${id}`);
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET /repositories/${id} failed with HTTP ${response.status}`);
  }
  return (await response.json()) as RepositoryDto;
}

export default async function RepositoryDetailPage({ params }: PageProps<"/repositories/[id]">) {
  await requireUser();
  const { id } = await params;
  const repository = await getRepository(id);

  if (!repository) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <div className="flex flex-col gap-2">
          <Link href="/repositories" className="w-fit text-xs text-muted-foreground hover:underline">
            &larr; Repositories
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{repository.fullName}</h1>
            <Badge variant={repository.private ? "outline" : "secondary"} className="gap-1">
              {repository.private && <Lock className="size-3" />}
              {repository.private ? "Private" : "Public"}
            </Badge>
          </div>
          {repository.description && <p className="text-sm text-muted-foreground">{repository.description}</p>}
          <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="font-mono">{repository.defaultBranch}</span>
            <a
              href={repository.htmlUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 hover:underline"
            >
              View on GitHub
              <ExternalLink className="size-3" />
            </a>
          </div>
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <IngestionPanel repositoryId={repository.id} initialIngestion={repository.latestIngestion} />
      </Reveal>

      <Reveal delay={0.12}>
        <AnalysisPanel repositoryId={repository.id} ingestion={repository.latestIngestion} />
      </Reveal>
    </div>
  );
}
