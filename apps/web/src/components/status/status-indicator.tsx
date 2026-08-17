import { cn } from "@/lib/utils";

export type SystemStatus = "operational" | "checking" | "error";

const DOT_COLOR: Record<SystemStatus, string> = {
  operational: "bg-success",
  checking: "bg-warning",
  error: "bg-destructive",
};

const LABEL: Record<SystemStatus, string> = {
  operational: "Operational",
  checking: "Checking",
  error: "Disconnected",
};

/**
 * A small dot + label communicating real (never decorative) system state.
 * Operational pulses softly to read as "alive"; checking pulses faster to
 * read as "in progress"; error is intentionally static — motion here would
 * suggest things are still working when they aren't.
 */
export function StatusIndicator({
  status,
  label,
  className,
}: {
  status: SystemStatus;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span className="relative flex size-2">
        {status !== "error" && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
              DOT_COLOR[status],
              status === "checking" && "duration-700",
            )}
          />
        )}
        <span className={cn("relative inline-flex size-2 rounded-full", DOT_COLOR[status])} />
      </span>
      <span className="text-muted-foreground">{label ?? LABEL[status]}</span>
    </span>
  );
}
