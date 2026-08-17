import type { ReactNode } from "react";
import type { AuthenticatedUser } from "@developer-platform/shared";
import { AppSidebar } from "@/components/navigation/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

export function AppShell({
  children,
  user,
}: {
  children: ReactNode;
  user: AuthenticatedUser | null;
}) {
  return (
    <SidebarProvider>
      <AppSidebar user={user} />
      <SidebarInset className="min-w-0">
        <header className="flex h-14 min-w-0 shrink-0 items-center gap-2 border-b border-border px-4">
          <SidebarTrigger />
          <Separator orientation="vertical" className="h-4" />
          <span className="truncate text-sm text-muted-foreground">
            AI-powered repository analysis for developers
          </span>
        </header>
        {/* SidebarInset already renders a <main>, so this is a <div>, not a
            second nested <main> landmark. */}
        <div className="min-w-0 flex-1 overflow-x-hidden px-6 py-8 md:px-10">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
