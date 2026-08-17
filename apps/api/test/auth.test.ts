import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { checkDatabaseConnection, prisma } from "@developer-platform/database";
import { OAUTH_STATE_COOKIE_NAME, SESSION_COOKIE_NAME } from "@developer-platform/shared";
import type * as GitHubService from "../src/services/github.js";

const mockExchangeCodeForAccessToken = vi.fn();
const mockFetchAuthenticatedGitHubUser = vi.fn();

vi.mock("../src/services/github.js", async (importOriginal) => {
  const actual = await importOriginal<typeof GitHubService>();
  return {
    ...actual,
    exchangeCodeForAccessToken: mockExchangeCodeForAccessToken,
    fetchAuthenticatedGitHubUser: mockFetchAuthenticatedGitHubUser,
  };
});

const { buildApp } = await import("../src/app.js");

/** Pulls the value of a single cookie out of a raw Set-Cookie header list. */
function cookieValue(setCookieHeaders: string[] | undefined, name: string): string | undefined {
  const header = setCookieHeaders?.find((c) => c.startsWith(`${name}=`));
  return header?.split(";")[0]?.split("=")[1];
}

describe("GET /auth/github", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it("redirects to GitHub's authorize endpoint and sets a one-time state cookie", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/github" });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("state")).toBeTruthy();

    const stateCookie = cookieValue(response.cookies.map((c) => `${c.name}=${c.value}`), OAUTH_STATE_COOKIE_NAME);
    expect(stateCookie).toBe(location.searchParams.get("state"));
  });
});

describe("GET /auth/github/callback", () => {
  const app = buildApp();
  afterAll(async () => app.close());
  afterEach(() => {
    mockExchangeCodeForAccessToken.mockReset();
    mockFetchAuthenticatedGitHubUser.mockReset();
  });

  it("redirects to /login with access_denied when GitHub reports the user declined", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?error=access_denied",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/login?error=access_denied");
  });

  it("redirects to /login with invalid_state when there's no state cookie at all", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=abc&state=some-state",
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/login?error=invalid_state");
  });

  it("redirects to /login with invalid_state when the query state doesn't match the cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=abc&state=wrong-state",
      cookies: { [OAUTH_STATE_COOKIE_NAME]: "correct-state" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/login?error=invalid_state");
  });

  it("redirects to /login with missing_code when state matches but no code is present", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?state=matching-state",
      cookies: { [OAUTH_STATE_COOKIE_NAME]: "matching-state" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/login?error=missing_code");
  });

  it("clears the state cookie after a single use, win or lose", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?error=access_denied",
      cookies: { [OAUTH_STATE_COOKIE_NAME]: "whatever" },
    });
    const cleared = response.cookies.find((c) => c.name === OAUTH_STATE_COOKIE_NAME);
    expect(cleared?.value).toBe("");
  });

  it("redirects to /login with github_unavailable when the token exchange fails", async () => {
    const { GitHubApiError } = await import("../src/services/github.js");
    mockExchangeCodeForAccessToken.mockRejectedValue(new GitHubApiError("boom", 502));

    const response = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=abc&state=s",
      cookies: { [OAUTH_STATE_COOKIE_NAME]: "s" },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain("/login?error=github_unavailable");
  });
});

const dbAvailable = await checkDatabaseConnection();

describe.runIf(dbAvailable)("full session lifecycle (live database)", () => {
  const app = buildApp();
  const testGithubId = 90_000_001; // fixed, well outside real GitHub's id space

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { githubAccount: { githubId: testGithubId } } });
    await app.close();
  });
  afterEach(() => {
    mockExchangeCodeForAccessToken.mockReset();
    mockFetchAuthenticatedGitHubUser.mockReset();
  });

  it("creates a user + GitHub account + session on a successful callback, then /auth/me and /auth/status reflect it, then logout revokes it", async () => {
    mockExchangeCodeForAccessToken.mockResolvedValue({ accessToken: "gho_test_token", scope: "read:user,repo" });
    mockFetchAuthenticatedGitHubUser.mockResolvedValue({
      githubId: testGithubId,
      username: "test-octocat",
      avatarUrl: "https://example.com/avatar.png",
    });

    const callback = await app.inject({
      method: "GET",
      url: "/auth/github/callback?code=valid-code&state=s",
      cookies: { [OAUTH_STATE_COOKIE_NAME]: "s" },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(process.env.WEB_URL);

    const sessionToken = cookieValue(
      callback.cookies.map((c) => `${c.name}=${c.value}`),
      SESSION_COOKIE_NAME,
    );
    expect(sessionToken).toBeTruthy();

    // The access token must never appear anywhere in the redirect response.
    expect(JSON.stringify(callback.cookies)).not.toContain("gho_test_token");

    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionToken! },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ githubUsername: "test-octocat" });
    expect(JSON.stringify(me.json())).not.toContain("gho_test_token");

    const status = await app.inject({
      method: "GET",
      url: "/auth/status",
      cookies: { [SESSION_COOKIE_NAME]: sessionToken! },
    });
    expect(status.json()).toEqual({ authenticated: true, githubConnected: true });

    const logout = await app.inject({
      method: "POST",
      url: "/auth/logout",
      cookies: { [SESSION_COOKIE_NAME]: sessionToken! },
    });
    expect(logout.statusCode).toBe(200);

    const afterLogout = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: sessionToken! },
    });
    expect(afterLogout.statusCode).toBe(401);
  });
});

describe("unauthenticated access", () => {
  const app = buildApp();
  afterAll(async () => app.close());

  it("GET /auth/me returns 401 without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/me" });
    expect(response.statusCode).toBe(401);
  });

  it("GET /auth/status returns not-authenticated without a session", async () => {
    const response = await app.inject({ method: "GET", url: "/auth/status" });
    expect(response.json()).toEqual({ authenticated: false, githubConnected: false });
  });

  it("GET /auth/me returns 401 for a garbage/unknown session cookie", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/auth/me",
      cookies: { [SESSION_COOKIE_NAME]: "not-a-real-session-token" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("POST /auth/logout succeeds even with no active session (idempotent)", async () => {
    const response = await app.inject({ method: "POST", url: "/auth/logout" });
    expect(response.statusCode).toBe(200);
  });
});
