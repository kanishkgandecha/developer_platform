import { AlertCircle, Database, GitBranch, Server, Workflow, Zap } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { HealthStatus } from "@developer-platform/shared";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Reveal } from "@/components/motion/reveal";
import { StatusIndicator, type SystemStatus } from "@/components/status/status-indicator";
import { getCurrentUser } from "@/lib/api";

// The API isn't reachable at `next build` time (and its health genuinely
// changes at request time), so this page is rendered per-request rather
// than statically generated.
export const dynamic = "force-dynamic";

// `API_URL` is the server-side address (e.g. `http://api:4000` inside Docker
// Compose's network). `NEXT_PUBLIC_API_URL` is the browser-facing fallback
// used for local `pnpm dev` without Docker, where both resolve to localhost.
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

interface FetchResult {
  health?: HealthStatus;
  error?: string;
}

async function fetchApiHealth(): Promise<FetchResult> {
  try {
    const response = await fetch(`${API_URL}/health`, { cache: "no-store" });
    if (!response.ok) {
      return { error: `API responded with HTTP ${response.status}` };
    }
    return { health: (await response.json()) as HealthStatus };
  } catch (cause) {
    return {
      error: cause instanceof Error ? cause.message : "Unknown error reaching the API",
    };
  }
}

function ServiceRow({
  icon: Icon,
  label,
  status,
}: {
  icon: LucideIcon;
  label: string;
  status: SystemStatus;
}) {
  return (
    <div className="flex items-center justify-between py-3">
      <span className="flex items-center gap-2.5 text-sm">
        <Icon className="size-4 text-muted-foreground" />
        {label}
      </span>
      <StatusIndicator status={status} />
    </div>
  );
}

export default async function StatusPage() {
  const [{ health, error }, user] = await Promise.all([fetchApiHealth(), getCurrentUser()]);
  const apiStatus: SystemStatus = error ? "error" : health?.status === "ok" ? "operational" : "error";

  return (
    <div className="flex flex-col gap-6">
      <Reveal>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System status</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Live check against <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{API_URL}/health</code> —
            every value below is the real response, not a placeholder.
          </p>
        </div>
      </Reveal>

      {error ? (
        <Reveal delay={0.06}>
          <Alert variant="destructive">
            <AlertCircle />
            <AlertTitle>API unreachable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </Reveal>
      ) : (
        <Reveal delay={0.06}>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Services</CardTitle>
                <StatusIndicator status={apiStatus} />
              </div>
              <CardDescription>
                {health?.environment} &middot; checked {health?.timestamp}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ServiceRow icon={Server} label="API" status={apiStatus} />
              <Separator />
              <ServiceRow
                icon={Database}
                label="PostgreSQL"
                status={health?.checks.database === "ok" ? "operational" : "error"}
              />
              <Separator />
              <ServiceRow
                icon={Zap}
                label="Redis"
                status={health?.checks.redis === "ok" ? "operational" : "error"}
              />
              <Separator />
              <ServiceRow
                icon={Workflow}
                label="Worker"
                status={health?.checks.worker === "ok" ? "operational" : "error"}
              />
              <Separator />
              <div className="flex items-center justify-between py-3">
                <span className="flex items-center gap-2.5 text-sm">
                  <GitBranch className="size-4 text-muted-foreground" />
                  GitHub OAuth
                </span>
                <Badge variant={health?.checks.githubOAuth === "configured" ? "secondary" : "outline"}>
                  {health?.checks.githubOAuth === "configured" ? "Configured" : "Not configured"}
                </Badge>
              </div>
              <Separator />
              <div className="flex items-center justify-between py-3">
                <span className="text-sm">Your session</span>
                <Badge variant={user ? "secondary" : "outline"}>
                  {user ? `Signed in as ${user.githubUsername}` : "Not signed in"}
                </Badge>
              </div>
            </CardContent>
          </Card>
        </Reveal>
      )}
    </div>
  );
}
