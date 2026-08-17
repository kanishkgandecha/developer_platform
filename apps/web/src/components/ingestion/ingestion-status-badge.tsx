import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { IngestionStatus } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const ACTIVE_LABEL: Record<string, string> = {
  PENDING: "Queued",
  QUEUED: "Queued",
  RETRIEVING: "Retrieving…",
  EXTRACTING: "Extracting…",
  SCANNING: "Scanning…",
};

/**
 * Real ingestion status, everywhere it appears (repositories list, detail
 * page) — never a fabricated/placeholder state. `status: null` means "never
 * ingested," rendered as a neutral "Ready" badge, not an error.
 */
export function IngestionStatusBadge({
  status,
  className,
}: {
  status: IngestionStatus | null;
  className?: string;
}) {
  if (!status) {
    return (
      <Badge variant="outline" className={cn("text-muted-foreground", className)}>
        Ready
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

  if (status === "FAILED") {
    return (
      <Badge variant="outline" className={cn("gap-1 border-destructive/40 text-destructive", className)}>
        <XCircle className="size-3" />
        Failed
      </Badge>
    );
  }

  if (status === "CANCELLED") {
    return (
      <Badge variant="outline" className={cn("text-muted-foreground", className)}>
        Cancelled
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
