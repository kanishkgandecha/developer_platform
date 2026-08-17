"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LogOut } from "lucide-react";
import { SidebarMenuButton } from "@/components/ui/sidebar";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function LogoutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function handleLogout() {
    setPending(true);
    try {
      await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" });
    } finally {
      // Navigate regardless of whether the request itself succeeded — the
      // cookie is cleared server-side either way, and staying on a page
      // that thinks it's authenticated helps no one.
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <SidebarMenuButton onClick={handleLogout} disabled={pending} tooltip="Log out">
      <LogOut />
      <span>{pending ? "Logging out…" : "Log out"}</span>
    </SidebarMenuButton>
  );
}
