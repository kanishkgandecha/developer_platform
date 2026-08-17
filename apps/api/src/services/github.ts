import { Octokit } from "@octokit/rest";
import { env } from "../env.js";

/**
 * Scope requested from GitHub. `read:user` for identity. GitHub's *classic*
 * OAuth App scopes don't offer a read-only repository grant — `repo` is the
 * narrowest scope that includes private repositories, and it technically
 * carries write capability we never exercise (this app only ever calls
 * read endpoints against GitHub). Documented in docs/github-integration.md;
 * a future phase could move to a GitHub App with fine-grained, genuinely
 * read-only installation permissions to close this gap.
 */
export const GITHUB_OAUTH_SCOPE = "read:user repo";

const GITHUB_API_TIMEOUT_MS = 10_000;

export class GitHubApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

/** True once real (non-placeholder) OAuth App credentials are configured. */
export function isGitHubOAuthConfigured(): boolean {
  return (
    !env.GITHUB_CLIENT_ID.startsWith("dev-placeholder") &&
    !env.GITHUB_CLIENT_SECRET.startsWith("dev-placeholder")
  );
}

export function buildGitHubAuthorizeUrl(state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.API_PUBLIC_URL}/auth/github/callback`);
  url.searchParams.set("scope", GITHUB_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "false");
  return url.toString();
}

interface GitHubTokenResponse {
  access_token: string;
  scope: string;
  token_type: string;
}

interface GitHubTokenErrorResponse {
  error: string;
  error_description?: string;
}

/**
 * Exchanges a one-time OAuth authorization code for an access token. Uses
 * plain fetch (not Octokit) — this is a single, simple POST and doesn't
 * benefit from a full API client.
 */
export async function exchangeCodeForAccessToken(
  code: string,
): Promise<{ accessToken: string; scope: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${env.API_PUBLIC_URL}/auth/github/callback`,
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    throw new GitHubApiError("Could not reach GitHub to exchange the authorization code", 502, cause);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new GitHubApiError(
      `GitHub token exchange responded with HTTP ${response.status}`,
      502,
    );
  }

  const body = (await response.json()) as GitHubTokenResponse | GitHubTokenErrorResponse;
  if ("error" in body) {
    throw new GitHubApiError(
      body.error_description ?? `GitHub rejected the OAuth exchange: ${body.error}`,
      400,
    );
  }

  return { accessToken: body.access_token, scope: body.scope };
}

function buildOctokit(accessToken: string): Octokit {
  return new Octokit({
    auth: accessToken,
    userAgent: "developer-platform",
    request: { timeout: GITHUB_API_TIMEOUT_MS },
  });
}

/** Maps any Octokit failure to our own error type — never leaks GitHub's raw error shape to callers/users. */
function toGitHubApiError(error: unknown): GitHubApiError {
  const status = typeof (error as { status?: number })?.status === "number"
    ? (error as { status: number }).status
    : 502;

  if (status === 401) {
    return new GitHubApiError("GitHub access token is invalid or has been revoked", 401, error);
  }
  if (status === 403) {
    return new GitHubApiError("GitHub API rate limit exceeded or access forbidden", 429, error);
  }
  return new GitHubApiError("GitHub API request failed", status, error);
}

export interface GitHubIdentity {
  githubId: number;
  username: string;
  avatarUrl: string | null;
}

export async function fetchAuthenticatedGitHubUser(accessToken: string): Promise<GitHubIdentity> {
  try {
    const { data } = await buildOctokit(accessToken).rest.users.getAuthenticated();
    return { githubId: data.id, username: data.login, avatarUrl: data.avatar_url ?? null };
  } catch (error) {
    throw toGitHubApiError(error);
  }
}

export interface NormalizedGitHubRepository {
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
}

/** Hard cap so a user with an enormous number of repos can't turn "list my repos" into an unbounded job. */
const MAX_REPOSITORIES = 500;
const PER_PAGE = 100;

/**
 * Lists every repository the authenticated user can access (own + org +
 * collaborator), paginating past GitHub's 100-per-page limit up to
 * MAX_REPOSITORIES. Does not clone or fetch repository contents — metadata
 * only.
 */
export async function listAuthenticatedRepositories(
  accessToken: string,
): Promise<NormalizedGitHubRepository[]> {
  const octokit = buildOctokit(accessToken);
  const repositories: NormalizedGitHubRepository[] = [];

  try {
    for (let page = 1; repositories.length < MAX_REPOSITORIES; page += 1) {
      const { data } = await octokit.rest.repos.listForAuthenticatedUser({
        per_page: PER_PAGE,
        page,
        sort: "updated",
        affiliation: "owner,collaborator,organization_member",
      });

      for (const repo of data) {
        repositories.push({
          githubId: repo.id,
          owner: repo.owner.login,
          name: repo.name,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
          htmlUrl: repo.html_url,
          description: repo.description ?? null,
        });
      }

      if (data.length < PER_PAGE) {
        break;
      }
    }
  } catch (error) {
    throw toGitHubApiError(error);
  }

  return repositories.slice(0, MAX_REPOSITORIES);
}

/**
 * Resolves a branch name to its current HEAD commit SHA — used to decide
 * whether a repository needs (re-)ingesting (see docs/repository-ingestion.md's
 * idempotency section) before any heavy work (the actual archive download)
 * starts. A 404 here means the branch or repository doesn't exist, or the
 * user's token no longer has access to it.
 */
export async function getBranchHeadSha(
  accessToken: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  try {
    const { data } = await buildOctokit(accessToken).rest.repos.getBranch({ owner, repo, branch });
    return data.commit.sha;
  } catch (error) {
    throw toGitHubApiError(error);
  }
}
