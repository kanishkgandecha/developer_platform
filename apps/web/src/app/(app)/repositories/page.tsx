import type { RepositoryDto } from "@developer-platform/shared";
import { Reveal } from "@/components/motion/reveal";
import { RepositoriesList } from "@/components/repositories/repositories-list";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getInitialRepositories(): Promise<RepositoryDto[]> {
  const response = await serverFetch("/repositories");
  if (!response.ok) {
    return [];
  }
  const { repositories } = (await response.json()) as { repositories: RepositoryDto[] };
  return repositories;
}

export default async function RepositoriesPage() {
  await requireUser();
  const initialRepositories = await getInitialRepositories();

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Repositories your GitHub account can access. Metadata only — nothing is cloned,
            downloaded, or analyzed yet.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <RepositoriesList initialRepositories={initialRepositories} />
      </Reveal>
    </div>
  );
}
