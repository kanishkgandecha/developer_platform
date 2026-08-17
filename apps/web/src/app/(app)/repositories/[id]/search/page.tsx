import Link from "next/link";
import { notFound } from "next/navigation";
import type { RepositoryDto } from "@developer-platform/shared";
import { SemanticSearch } from "@/components/search/semantic-search";
import { Reveal } from "@/components/motion/reveal";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getRepository(id: string): Promise<RepositoryDto | null> {
  const response = await serverFetch(`/repositories/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /repositories/${id} failed with HTTP ${response.status}`);
  return (await response.json()) as RepositoryDto;
}

export default async function RepositorySearchPage({ params }: PageProps<"/repositories/[id]/search">) {
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
          <Link href={`/repositories/${id}`} className="w-fit text-xs text-muted-foreground hover:underline">
            &larr; {repository.fullName}
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">Code Search</h1>
          <p className="text-sm text-muted-foreground">
            Semantic + lexical retrieval over {repository.fullName}&apos;s indexed source — no chat, no AI-generated
            answers, just the chunks and citations retrieval actually found.
          </p>
        </div>
      </Reveal>

      <Reveal delay={0.06}>
        <SemanticSearch repositoryId={repository.id} />
      </Reveal>
    </div>
  );
}
