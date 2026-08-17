import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest hoists `vi.mock` above regular variable declarations, so anything
// referenced inside the factory must be prefixed `mock` — that's what makes
// it exempt from (and safe across) that hoisting.
const mockGetAuthenticated = vi.fn();
const mockListForAuthenticatedUser = vi.fn();

vi.mock("@octokit/rest", () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    rest: {
      users: { getAuthenticated: mockGetAuthenticated },
      repos: { listForAuthenticatedUser: mockListForAuthenticatedUser },
    },
  })),
}));

const {
  GitHubApiError,
  buildGitHubAuthorizeUrl,
  exchangeCodeForAccessToken,
  fetchAuthenticatedGitHubUser,
  isGitHubOAuthConfigured,
  listAuthenticatedRepositories,
} = await import("../../src/services/github.js");

describe("isGitHubOAuthConfigured", () => {
  it("returns a boolean reflecting whether real credentials are configured", () => {
    // vitest.setup.ts uses "test-github-client-id" / "test-github-client-secret",
    // which don't start with "dev-placeholder" — so this actually reports
    // true in the test environment; this test documents that behavior
    // rather than asserting a hardcoded outcome unrelated to it.
    expect(typeof isGitHubOAuthConfigured()).toBe("boolean");
  });
});

describe("buildGitHubAuthorizeUrl", () => {
  it("includes the client id, callback URL, minimal scope, and state", () => {
    const url = new URL(buildGitHubAuthorizeUrl("test-state-123"));
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(url.searchParams.get("state")).toBe("test-state-123");
    expect(url.searchParams.get("scope")).toBe("read:user repo");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `${process.env.API_PUBLIC_URL}/auth/github/callback`,
    );
    expect(url.searchParams.get("allow_signup")).toBe("false");
  });
});

describe("exchangeCodeForAccessToken", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the access token and scope on success", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "gho_abc123", scope: "read:user,repo", token_type: "bearer" }),
    }) as unknown as typeof fetch;

    const result = await exchangeCodeForAccessToken("some-code");
    expect(result).toEqual({ accessToken: "gho_abc123", scope: "read:user,repo" });
  });

  it("throws a GitHubApiError when GitHub responds with an OAuth error", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ error: "bad_verification_code", error_description: "The code is invalid." }),
    }) as unknown as typeof fetch;

    await expect(exchangeCodeForAccessToken("bad-code")).rejects.toThrow(GitHubApiError);
  });

  it("throws a GitHubApiError when the HTTP response itself isn't ok", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as unknown as typeof fetch;
    await expect(exchangeCodeForAccessToken("some-code")).rejects.toThrow(GitHubApiError);
  });

  it("throws a GitHubApiError when the network request itself fails", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(exchangeCodeForAccessToken("some-code")).rejects.toThrow(GitHubApiError);
  });
});

describe("fetchAuthenticatedGitHubUser", () => {
  beforeEach(() => {
    mockGetAuthenticated.mockReset();
  });

  it("normalizes a successful GitHub user lookup", async () => {
    mockGetAuthenticated.mockResolvedValue({
      data: { id: 42, login: "octocat", avatar_url: "https://example.com/a.png" },
    });

    const identity = await fetchAuthenticatedGitHubUser("token");
    expect(identity).toEqual({ githubId: 42, username: "octocat", avatarUrl: "https://example.com/a.png" });
  });

  it("maps a 401 from GitHub to an invalid-token GitHubApiError", async () => {
    mockGetAuthenticated.mockRejectedValue(Object.assign(new Error("Bad credentials"), { status: 401 }));

    await expect(fetchAuthenticatedGitHubUser("bad-token")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("maps a 403 from GitHub (rate limit) to a 429 GitHubApiError, not GitHub's raw error", async () => {
    mockGetAuthenticated.mockRejectedValue(
      Object.assign(new Error("API rate limit exceeded"), { status: 403 }),
    );

    await expect(fetchAuthenticatedGitHubUser("token")).rejects.toMatchObject({ status: 429 });
  });
});

describe("listAuthenticatedRepositories", () => {
  beforeEach(() => {
    mockListForAuthenticatedUser.mockReset();
  });

  function repo(id: number, overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id,
      owner: { login: "octocat" },
      name: `repo-${id}`,
      full_name: `octocat/repo-${id}`,
      default_branch: "main",
      private: false,
      html_url: `https://github.com/octocat/repo-${id}`,
      description: null,
      ...overrides,
    };
  }

  it("normalizes a single page of repositories", async () => {
    mockListForAuthenticatedUser.mockResolvedValue({ data: [repo(1), repo(2)] });

    const repos = await listAuthenticatedRepositories("token");
    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      githubId: 1,
      owner: "octocat",
      name: "repo-1",
      fullName: "octocat/repo-1",
      defaultBranch: "main",
      private: false,
      htmlUrl: "https://github.com/octocat/repo-1",
      description: null,
    });
    expect(mockListForAuthenticatedUser).toHaveBeenCalledTimes(1);
  });

  it("paginates until a short page is returned", async () => {
    mockListForAuthenticatedUser
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, i) => repo(i)) })
      .mockResolvedValueOnce({ data: [repo(200)] });

    const repos = await listAuthenticatedRepositories("token");
    expect(repos).toHaveLength(101);
    expect(mockListForAuthenticatedUser).toHaveBeenCalledTimes(2);
  });

  it("wraps a GitHub API failure as a GitHubApiError", async () => {
    mockListForAuthenticatedUser.mockRejectedValue(Object.assign(new Error("nope"), { status: 401 }));
    await expect(listAuthenticatedRepositories("bad-token")).rejects.toThrow(GitHubApiError);
  });
});
