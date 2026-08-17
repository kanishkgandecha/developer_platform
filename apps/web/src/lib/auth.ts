import { redirect } from "next/navigation";
import type { AuthenticatedUser } from "@developer-platform/shared";
import { getCurrentUser } from "./api";

/**
 * Guards a Server Component page: resolves the signed-in user or redirects
 * to /login. This — not client-side JS, not Next.js middleware peeking at
 * cookie presence — is the real authorization boundary for pages, mirroring
 * how every protected API route independently requires a valid session too.
 */
export async function requireUser(): Promise<AuthenticatedUser> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}
