"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ShieldCheck } from "lucide-react";
import type { AgentType, AIFindingDto, AIFindingSeverity } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-states/empty-state";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const PAGE_SIZE = 15;

const SEVERITY_OPTIONS: AIFindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const AGENT_OPTIONS: AgentType[] = ["ARCHITECTURE", "CODE_QUALITY", "SECURITY", "PERFORMANCE", "DEPENDENCY_RISK", "DOCUMENTATION", "EXECUTIVE_SUMMARY"];
const SEVERITY_BADGE_VARIANT: Record<AIFindingSeverity, "destructive" | "outline" | "secondary"> = {
  CRITICAL: "destructive",
  HIGH: "destructive",
  MEDIUM: "outline",
  LOW: "secondary",
  INFO: "secondary",
};

interface FindingsResponse {
  findings: AIFindingDto[];
  total: number;
  page: number;
  pageSize: number;
}

function FilterSelect({ value, onChange, options, placeholder }: { value: string; onChange: (value: string) => void; options: string[]; placeholder: string }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option.replaceAll("_", " ")}
        </option>
      ))}
    </select>
  );
}

function FindingRow({ finding }: { finding: AIFindingDto }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        <TableCell>{expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}</TableCell>
        <TableCell>
          <Badge variant={SEVERITY_BADGE_VARIANT[finding.severity]}>{finding.severity}</Badge>
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{finding.agent.replaceAll("_", " ")}</TableCell>
        <TableCell className="max-w-md whitespace-normal">{finding.title}</TableCell>
        <TableCell className="text-right font-mono text-xs text-muted-foreground">{finding.confidence.toFixed(2)}</TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={5} className="p-0 whitespace-normal">
            <div className="flex flex-col gap-3 border-t border-border bg-muted/20 p-4 text-xs">
              <p className="text-foreground">{finding.summary}</p>
              <div>
                <span className="font-medium text-foreground">Evidence: </span>
                <span className="text-muted-foreground">{finding.evidence}</span>
              </div>
              <div>
                <span className="font-medium text-foreground">Recommendation: </span>
                <span className="text-muted-foreground">{finding.recommendation}</span>
              </div>
              {finding.citations.length > 0 && (
                <div className="flex flex-col gap-1">
                  <span className="font-medium text-foreground">Citations</span>
                  {finding.citations.map((citation, i) => (
                    <div key={i} className="flex items-center gap-2 font-mono text-muted-foreground">
                      <span>{citation.filePath}</span>
                      {citation.startLine !== null && (
                        <span>
                          :{citation.startLine}
                          {citation.endLine !== null && citation.endLine !== citation.startLine ? `-${citation.endLine}` : ""}
                        </span>
                      )}
                      {citation.symbolName && <Badge variant="outline" className="text-[10px]">{citation.symbolName}</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** AI-generated findings — filterable by severity/agent/confidence, each row expandable to reveal its evidence, recommendation, and citations. Every finding is evidence-backed; see docs/ai-analysis.md. */
export function AIFindingsExplorer({ aiAnalysisId }: { aiAnalysisId: string }) {
  const [severity, setSeverity] = useState("");
  const [agent, setAgent] = useState("");
  const [minConfidence, setMinConfidence] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<FindingsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (severity) query.set("severity", severity);
    if (agent) query.set("agent", agent);
    if (minConfidence) query.set("minConfidence", minConfidence);

    fetch(`${API_URL}/ai-analysis/${aiAnalysisId}/findings?${query.toString()}`, { credentials: "include" })
      .then((response) => (response.ok ? (response.json() as Promise<FindingsResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [aiAnalysisId, severity, agent, minConfidence, page]);

  function handleSeverityChange(value: string) {
    setSeverity(value);
    setPage(1);
  }
  function handleAgentChange(value: string) {
    setAgent(value);
    setPage(1);
  }
  function handleConfidenceChange(value: string) {
    setMinConfidence(value);
    setPage(1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>AI Findings</CardTitle>
            <CardDescription>Every finding cites the real file/line evidence it was grounded in — click a row to see it.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <FilterSelect value={severity} onChange={handleSeverityChange} options={SEVERITY_OPTIONS} placeholder="All severities" />
            <FilterSelect value={agent} onChange={handleAgentChange} options={AGENT_OPTIONS} placeholder="All agents" />
            <FilterSelect value={minConfidence} onChange={handleConfidenceChange} options={["0.9", "0.75", "0.5"]} placeholder="Any confidence" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {data && data.findings.length === 0 && (
          <EmptyState icon={ShieldCheck} title="No findings" description="Nothing matched the current filters." />
        )}

        {data && data.findings.length > 0 && (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead />
                  <TableHead>Severity</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Finding</TableHead>
                  <TableHead className="text-right">Confidence</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.findings.map((finding) => (
                  <FindingRow key={finding.id} finding={finding} />
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Page {data.page} of {totalPages} · {data.total} finding{data.total === 1 ? "" : "s"}
              </span>
              <div className="flex gap-1">
                <Button variant="outline" size="icon-sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button variant="outline" size="icon-sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
