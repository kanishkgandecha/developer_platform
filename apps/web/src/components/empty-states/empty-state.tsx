import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Consistent empty-state layout: icon, title, short explanation, optional
 * action. Used wherever a section has no real data yet (Phase 1: only the
 * dashboard's "no repositories" state — later phases reuse this for
 * analyses/findings).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted">
        <Icon className="size-5 text-muted-foreground" />
      </div>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
