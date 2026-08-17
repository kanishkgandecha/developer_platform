import Link from "next/link";
import { redirect } from "next/navigation";
import { GitBranch, ShieldCheck } from "lucide-react";
import { AbstractBackground } from "@/components/motion/abstract-background";
import { Reveal } from "@/components/motion/reveal";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/api";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "You cancelled the GitHub sign-in.",
  invalid_state: "That sign-in link expired or was already used — please try again.",
  invalid_callback: "GitHub sent back something we couldn't understand — please try again.",
  missing_code: "GitHub didn't send an authorization code — please try again.",
  github_unavailable: "GitHub is temporarily unavailable — please try again shortly.",
};

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const user = await getCurrentUser();
  if (user) {
    redirect("/");
  }

  const { error } = await searchParams;
  const errorCode = typeof error === "string" ? error : undefined;
  const errorMessage = errorCode ? (ERROR_MESSAGES[errorCode] ?? "Something went wrong — please try again.") : undefined;

  return (
    <div className="flex min-h-svh items-center justify-center px-6 py-16">
      <Reveal className="w-full max-w-sm">
        <div className="relative overflow-hidden rounded-xl border border-border px-8 py-10 text-center">
          <AbstractBackground />
          <div className="relative flex flex-col items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                DP
              </span>
              <span className="text-sm font-semibold tracking-tight">Developer Platform</span>
            </Link>

            <div className="flex flex-col gap-1.5">
              <h1 className="text-xl font-semibold tracking-tight">
                Understand your codebase.
                <br />
                Improve your engineering.
              </h1>
            </div>

            {errorMessage && (
              <Alert variant="destructive" className="text-left">
                <AlertTitle>Sign-in failed</AlertTitle>
                <AlertDescription>{errorMessage}</AlertDescription>
              </Alert>
            )}

            <Button className="w-full gap-2" nativeButton={false} render={<a href={`${API_URL}/auth/github`} />}>
              <GitBranch className="size-4" />
              Continue with GitHub
            </Button>

            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              Secure OAuth authentication via GitHub
            </p>
          </div>
        </div>
      </Reveal>
    </div>
  );
}
