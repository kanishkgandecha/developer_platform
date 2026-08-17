import { cookies } from "next/headers";
// Imported from the `/auth` subpath, not the package's main barrel — Next
// 16's Turbopack production build fails to resolve *value* re-exports
// (constants, functions) routed through @developer-platform/shared's
// index.ts specifically (type-only re-exports through the same barrel are
// fine; apps/api and apps/worker also import the barrel's values without
// issue, since they bundle with tsup/esbuild, not Turbopack). Importing the
// value directly from its own subpath sidesteps the bug. See
// packages/shared/package.json's "exports" map.
import { SESSION_COOKIE_NAME } from "@developer-platform/shared/auth";
import type { AuthenticatedUser, AuthStatus } from "@developer-platform/shared";

// Server-side address (e.g. `http://api:4000` inside Docker Compose's
// network). Only ever used from Server Components/Route Handlers — never
// bundled into client-side JS.
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Fetches from the API on the server, forwarding the browser's session
 * cookie by hand. This is necessary (not automatic) because a Server
 * Component's `fetch` runs on the web server, not in the user's browser —
 * it doesn't share the browser's cookie jar, so without this the API would
 * see every SSR request as unauthenticated.
 */
async function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE_NAME);

  const headers = new Headers(init.headers);
  if (sessionCookie) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${sessionCookie.value}`);
  }

  return fetch(`${API_URL}${path}`, { ...init, headers, cache: "no-store" });
}

/** Returns the signed-in user, or `null` if there's no valid session. Never throws for "not authenticated" — only for the API being unreachable. */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const response = await serverFetch("/auth/me");
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`GET /auth/me failed with HTTP ${response.status}`);
  }
  return (await response.json()) as AuthenticatedUser;
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const response = await serverFetch("/auth/status");
  if (!response.ok) {
    throw new Error(`GET /auth/status failed with HTTP ${response.status}`);
  }
  return (await response.json()) as AuthStatus;
}

export { serverFetch };
