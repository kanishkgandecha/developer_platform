import type { ReactNode } from "react";
import { AppShell } from "@/components/layout/app-shell";
import { getCurrentUser } from "@/lib/api";

// This layout wraps every page that uses the sidebar app shell (dashboard,
// repositories, status). It fetches the current user once (nullable — some
// pages in this group, like /status, don't require auth) so the sidebar can
// show a real user menu / logout instead of each page re-fetching it.
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();
  return <AppShell user={user}>{children}</AppShell>;
}
