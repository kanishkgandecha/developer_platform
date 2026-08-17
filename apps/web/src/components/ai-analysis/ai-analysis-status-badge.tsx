import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { AIAnalysisStatus } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ACTIVE_LABEL: Record<string, string> = {
  PENDING: "Queued",
  QUEUED: "Queued",
  RUNNING: "Running…",
};

/** Mirrors EmbeddingStatusBadge/AnalysisStatusBadge's design — `status: null` means "never run," a neutral badge, not an error. */
export function AIAnalysisStatusBadge({ status, className }: { status: AIAnalysisStatus | null; className?: string }) {
  if (!status) {
    return (
      <Badge variant="outline" className={cn("text-muted-foreground", className)}>
        Not run
      </Badge>
    );
  }

  if (status === "COMPLETED") {
    return (
      <Badge variant="secondary" className={cn("gap-1 text-success", className)}>
        <CheckCircle2 className="size-3" />
        Completed
      </Badge>
    );
  }

  if (status === "COMPLETED_WITH_WARNINGS") {
    return (
      <Badge variant="outline" className={cn("gap-1 text-warning", className)}>
        <AlertTriangle className="size-3" />
        Completed with warnings
      </Badge>
    );
  }

  if (status === "FAILED") {
    return (
      <Badge variant="outline" className={cn("gap-1 border-destructive/40 text-destructive", className)}>
        <XCircle className="size-3" />
        Failed
      </Badge>
    );
  }

  return (
    <Badge variant="outline" className={cn("gap-1 text-warning", className)}>
      <Loader2 className="size-3 animate-spin" />
      {ACTIVE_LABEL[status] ?? status}
    </Badge>
  );
}
