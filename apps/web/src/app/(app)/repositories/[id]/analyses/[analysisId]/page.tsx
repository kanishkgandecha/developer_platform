import Link from "next/link";
import { notFound } from "next/navigation";
import type { AnalysisRunDto, CodeMetricDto } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AnalysisStatusBadge } from "@/components/analysis/analysis-status-badge";
import { CodeExplorer } from "@/components/analysis/code-explorer";
import { FindingsExplorer } from "@/components/analysis/findings-explorer";
import { Reveal } from "@/components/motion/reveal";
import { requireUser } from "@/lib/auth";
import { serverFetch } from "@/lib/api";

export const dynamic = "force-dynamic";

interface FileSummary {
  metrics: CodeMetricDto;
  symbolCount: number;
  importCount: number;
  findingCount: number;
}

async function getAnalysis(id: string): Promise<AnalysisRunDto | null> {
  const response = await serverFetch(`/analyses/${id}`);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET /analyses/${id} failed with HTTP ${response.status}`);
  return (await response.json()) as AnalysisRunDto;
}

async function getFiles(id: string): Promise<FileSummary[]> {
  const response = await serverFetch(`/analyses/${id}/files`);
  if (!response.ok) return [];
  const body = (await response.json()) as { files: FileSummary[] };
  return body.files;
}

export default async function AnalysisDetailPage({
  params,
}: PageProps<"/repositories/[id]/analyses/[analysisId]">) {
  await requireUser();
  const { id, analysisId } = await params;

  const [analysis, files] = await Promise.all([getAnalysis(analysisId), getFiles(analysisId)]);
  if (!analysis) {
    notFound();
  }

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <div className="flex flex-col gap-2">
          <Link href={`/repositories/${id}`} className="w-fit text-xs text-muted-foreground hover:underline">
            &larr; Repository
          </Link>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">Code Intelligence</h1>
            <AnalysisStatusBadge status={analysis.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            Deterministic static analysis — parsed symbols, resolved imports, and rule-based findings. No AI is
            involved in producing any of this.
          </p>
        </div>
      </Reveal>

      {analysis.status === "COMPLETED" && (
        <Reveal delay={0.06}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Summary</CardTitle>
              <CardDescription>
                {analysis.filesAnalyzed ?? 0} files analyzed · {analysis.symbolsFound ?? 0} symbols ·{" "}
                {analysis.importsFound ?? 0} imports · {analysis.findingsCount ?? 0} findings
              </CardDescription>
            </CardHeader>
            {analysis.severityCounts && (
              <CardContent className="flex flex-wrap gap-2">
                {(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const).map((severity) => (
                  <Badge key={severity} variant="outline" className="gap-1">
                    {severity}
                    <span className="font-mono">{analysis.severityCounts![severity]}</span>
                  </Badge>
                ))}
              </CardContent>
            )}
          </Card>
        </Reveal>
      )}

      {analysis.status === "COMPLETED" && (
        <>
          <Reveal delay={0.1}>
            <FindingsExplorer analysisId={analysis.id} />
          </Reveal>

          <Reveal delay={0.14}>
            <CodeExplorer analysisId={analysis.id} initialFiles={files} />
          </Reveal>
        </>
      )}
    </div>
  );
}
