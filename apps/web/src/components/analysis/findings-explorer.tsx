"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import type { FindingDto, Severity } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-states/empty-state";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const PAGE_SIZE = 20;

const SEVERITY_OPTIONS: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
// The fixed set of deterministic rules Phase 4 ships (packages/code-analysis/src/analysis/rules) —
// hardcoded rather than derived from the current (paginated) page of
// findings, which would only ever show whatever rule ids happen to appear
// on that one page.
const RULE_OPTIONS = ["COMPLEXITY_HIGH", "FILE_TOO_LARGE", "FUNCTION_TOO_LONG", "TOO_MANY_PARAMETERS", "TODO_COMMENT"];
const SEVERITY_BADGE_VARIANT: Record<Severity, "destructive" | "outline" | "secondary"> = {
  CRITICAL: "destructive",
  HIGH: "destructive",
  MEDIUM: "outline",
  LOW: "secondary",
  INFO: "secondary",
};

interface FindingsResponse {
  findings: FindingDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** A plain, unstyled-library `<select>` — this project has no dropdown/select primitive yet, and building one is out of scope for a filter control. */
function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

export function FindingsExplorer({ analysisId }: { analysisId: string }) {
  const [severity, setSeverity] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [page, setPage] = useState(1);
  // No separate `loading` flag: like use-ingestion-polling.ts, setState only
  // ever happens after a real async gap (the fetch response), never
  // synchronously in the effect body — the table simply keeps showing the
  // previous page's data until the new one arrives, rather than flashing a
  // spinner on every filter change.
  const [data, setData] = useState<FindingsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (severity) query.set("severity", severity);
    if (ruleId) query.set("ruleId", ruleId);

    fetch(`${API_URL}/analyses/${analysisId}/findings?${query.toString()}`, { credentials: "include" })
      .then((response) => (response.ok ? (response.json() as Promise<FindingsResponse>) : null))
      .then((body) => {
        if (!cancelled && body) setData(body);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [analysisId, severity, ruleId, page]);

  // A filter change should always jump back to page 1, not silently keep an out-of-range page.
  function handleSeverityChange(value: string) {
    setSeverity(value);
    setPage(1);
  }
  function handleRuleChange(value: string) {
    setRuleId(value);
    setPage(1);
  }

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Findings</CardTitle>
            <CardDescription>Deterministic rule-engine results — never AI-generated.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <FilterSelect value={severity} onChange={handleSeverityChange} options={SEVERITY_OPTIONS} placeholder="All severities" />
            <FilterSelect value={ruleId} onChange={handleRuleChange} options={RULE_OPTIONS} placeholder="All rules" />
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
                  <TableHead>Severity</TableHead>
                  <TableHead>Rule</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Location</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.findings.map((finding) => (
                  <TableRow key={finding.id}>
                    <TableCell>
                      <Badge variant={SEVERITY_BADGE_VARIANT[finding.severity]}>{finding.severity}</Badge>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{finding.ruleId}</TableCell>
                    <TableCell className="max-w-md whitespace-normal">{finding.message}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {finding.filePath ?? "—"}
                      {finding.line ? `:${finding.line}` : ""}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                Page {data.page} of {totalPages} · {data.total} finding{data.total === 1 ? "" : "s"}
              </span>
              <div className="flex gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
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
