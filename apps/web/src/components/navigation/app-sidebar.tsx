"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  FolderGit2,
  GitBranch,
  LayoutDashboard,
  type LucideIcon,
  Network,
  Settings,
  Sparkles,
} from "lucide-react";
import type { AuthenticatedUser } from "@developer-platform/shared";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { LogoutButton } from "./logout-button";

interface NavItem {
  label: string;
  href?: string;
  icon: LucideIcon;
}

const WORKSPACE_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/", icon: LayoutDashboard },
  { label: "Repositories", href: "/repositories", icon: FolderGit2 },
];

// Analyses and code-quality/AI findings are fully built, but reached via
// each repository's own detail page rather than a global cross-repository
// list — that's the intended navigation model (see docs/code-intelligence.md
// and docs/ai-analysis.md), not a placeholder. Only genuinely unbuilt items
// stay here, disabled: Architecture (dependency-graph visualization, a later
// phase per docs/architecture.md's roadmap) and AI Assistant (a chat
// interface, explicitly out of scope for this product — see docs/ai-analysis.md).
const INTELLIGENCE_ITEMS: NavItem[] = [
  { label: "Architecture", icon: Network },
  { label: "AI Assistant", icon: Sparkles },
];

function NavMenuItem({ item, pathname }: { item: NavItem; pathname: string }) {
  if (item.href) {
    return (
      <SidebarMenuItem>
        <SidebarMenuButton
          render={<Link href={item.href} />}
          isActive={pathname === item.href}
          tooltip={item.label}
        >
          <item.icon />
          <span>{item.label}</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    );
  }

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        disabled
        tooltip={`${item.label} — coming in a later phase`}
        className="cursor-not-allowed opacity-50"
      >
        <item.icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
      <SidebarMenuBadge className="text-[10px] text-muted-foreground">soon</SidebarMenuBadge>
    </SidebarMenuItem>
  );
}

export function AppSidebar({ user }: { user: AuthenticatedUser | null }) {
  const pathname = usePathname();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-3 py-3">
        <Link href="/" className="flex items-center gap-2 px-1">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
            DP
          </span>
          <span className="text-sm font-semibold tracking-tight group-data-[collapsible=icon]:hidden">
            Developer Platform
          </span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {WORKSPACE_ITEMS.map((item) => (
                <NavMenuItem key={item.label} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>Intelligence</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {INTELLIGENCE_ITEMS.map((item) => (
                <NavMenuItem key={item.label} item={item} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="mt-auto">
          <SidebarGroupLabel>System</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  render={<Link href="/status" />}
                  isActive={pathname === "/status"}
                  tooltip="Status"
                >
                  <Activity />
                  <span>Status</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  disabled
                  tooltip="Settings — coming in a later phase"
                  className="cursor-not-allowed opacity-50"
                >
                  <Settings />
                  <span>Settings</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border px-3 py-3">
        {user ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled
                className="cursor-default opacity-100"
                tooltip={user.githubUsername}
              >
                {user.githubAvatarUrl ? (
                  <Image
                    src={user.githubAvatarUrl}
                    alt=""
                    width={20}
                    height={20}
                    className="rounded-full"
                  />
                ) : (
                  <GitBranch />
                )}
                <span>{user.githubUsername}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <LogoutButton />
            </SidebarMenuItem>
          </SidebarMenu>
        ) : (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton render={<Link href="/login" />} tooltip="Sign in">
                <GitBranch />
                <span>Sign in with GitHub</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
