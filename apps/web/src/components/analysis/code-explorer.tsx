"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, FolderTree } from "lucide-react";
import type { CodeImportDto, CodeMetricDto, CodeSymbolDto } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/empty-states/empty-state";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface FileSummary {
  metrics: CodeMetricDto;
  symbolCount: number;
  importCount: number;
  findingCount: number;
}

interface FileDetail {
  metrics: CodeMetricDto;
  symbols: CodeSymbolDto[];
  imports: CodeImportDto[];
}

function FileDetailPanel({ detail }: { detail: FileDetail }) {
  return (
    <div className="flex flex-col gap-4 border-t border-border bg-muted/30 p-4 text-xs">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <span>Lines: {detail.metrics.lineCount}</span>
        <span>Code: {detail.metrics.codeLineCount}</span>
        <span>Comments: {detail.metrics.commentLineCount}</span>
        <span>Complexity: {detail.metrics.complexity ?? "—"}</span>
      </div>

      {detail.symbols.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-foreground">Symbols</span>
          <div className="flex flex-col gap-1">
            {detail.symbols.map((symbol) => (
              <div key={symbol.id} className="flex items-center gap-2 font-mono text-muted-foreground">
                <Badge variant="outline" className="text-[10px]">
                  {symbol.kind}
                </Badge>
                {symbol.parentName && <span>{symbol.parentName}.</span>}
                <span className="text-foreground">{symbol.name}</span>
                <span>
                  L{symbol.startLine}–{symbol.endLine}
                </span>
                {symbol.complexity !== null && <span>complexity {symbol.complexity}</span>}
                {symbol.exported && (
                  <Badge variant="secondary" className="text-[10px]">
                    exported
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.imports.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="font-medium text-foreground">Imports</span>
          <div className="flex flex-col gap-1">
            {detail.imports.map((imp) => (
              <div key={imp.id} className="flex items-center gap-2 font-mono text-muted-foreground">
                <span>{imp.source}</span>
                {imp.resolvedFilePath ? (
                  <span className="text-foreground">→ {imp.resolvedFilePath}</span>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    external
                  </Badge>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {detail.symbols.length === 0 && detail.imports.length === 0 && (
        <span className="text-muted-foreground">No symbols or imports were extracted from this file.</span>
      )}
    </div>
  );
}

function FileRow({ analysisId, file }: { analysisId: string; file: FileSummary }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<FileDetail | null>(null);
  const [loading, setLoading] = useState(false);

  async function toggle() {
    const next = !expanded;
    setExpanded(next);
    if (next && !detail) {
      setLoading(true);
      try {
        const response = await fetch(`${API_URL}/analyses/${analysisId}/files/${file.metrics.fileId}`, {
          credentials: "include",
        });
        if (response.ok) {
          setDetail((await response.json()) as FileDetail);
        }
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <>
      <TableRow className="cursor-pointer" onClick={() => void toggle()} aria-expanded={expanded}>
        <TableCell>
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </TableCell>
        <TableCell className="font-mono text-xs">{file.metrics.filePath}</TableCell>
        <TableCell className="text-right">{file.metrics.lineCount}</TableCell>
        <TableCell className="text-right">{file.symbolCount}</TableCell>
        <TableCell className="text-right">{file.importCount}</TableCell>
        <TableCell className="text-right">
          {file.findingCount > 0 ? (
            <Badge variant="destructive">{file.findingCount}</Badge>
          ) : (
            <span className="text-muted-foreground">0</span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="p-0 whitespace-normal">
            {loading && <p className="p-4 text-xs text-muted-foreground">Loading…</p>}
            {!loading && detail && <FileDetailPanel detail={detail} />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** A file-level code explorer — deliberately not a full code browser (no source viewer), just symbols/imports/metrics per file. See docs/code-intelligence.md. */
export function CodeExplorer({ analysisId, initialFiles }: { analysisId: string; initialFiles: FileSummary[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Code Explorer</CardTitle>
        <CardDescription>Every analyzed file — click a row for its symbols and imports.</CardDescription>
      </CardHeader>
      <CardContent>
        {initialFiles.length === 0 ? (
          <EmptyState icon={FolderTree} title="No files" description="No source files were analyzed." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>File</TableHead>
                <TableHead className="text-right">Lines</TableHead>
                <TableHead className="text-right">Symbols</TableHead>
                <TableHead className="text-right">Imports</TableHead>
                <TableHead className="text-right">Findings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {initialFiles.map((file) => (
                <FileRow key={file.metrics.fileId} analysisId={analysisId} file={file} />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
