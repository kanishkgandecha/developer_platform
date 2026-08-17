import { CheckCircle2, Loader2, MinusCircle, XCircle } from "lucide-react";
import type { AgentRunDto } from "@developer-platform/shared";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function statusIcon(status: AgentRunDto["status"]) {
  switch (status) {
    case "COMPLETED":
      return <CheckCircle2 className="size-3.5 text-success" />;
    case "FAILED":
      return <XCircle className="size-3.5 text-destructive" />;
    case "SKIPPED":
      return <MinusCircle className="size-3.5 text-muted-foreground" />;
    case "RUNNING":
      return <Loader2 className="size-3.5 animate-spin text-warning" />;
    default:
      return <Loader2 className="size-3.5 text-muted-foreground" />;
  }
}

/** One card per agent (six primary + the executive summary) — status, summary, and finding count. Never a fake chart; just what the agent actually produced. */
export function AgentCards({ agents }: { agents: AgentRunDto[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <Card key={agent.id}>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">{agent.agent.replaceAll("_", " ")}</CardTitle>
              {statusIcon(agent.status)}
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {agent.status === "COMPLETED" && (
              <>
                <p className="text-xs text-muted-foreground">{agent.summary}</p>
                <Badge variant="outline" className="w-fit text-[10px]">
                  {agent.findings?.length ?? 0} finding{(agent.findings?.length ?? 0) === 1 ? "" : "s"}
                </Badge>
              </>
            )}
            {agent.status === "FAILED" && <p className="text-xs text-destructive">{agent.error ?? "This agent failed."}</p>}
            {agent.status === "SKIPPED" && <p className="text-xs text-muted-foreground">{agent.error ?? "Skipped."}</p>}
            {(agent.status === "PENDING" || agent.status === "RUNNING") && (
              <p className="text-xs text-muted-foreground">{agent.status === "RUNNING" ? "Running…" : "Queued…"}</p>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
