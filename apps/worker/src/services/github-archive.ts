import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";

const CONNECT_TIMEOUT_MS = 15_000;

export class GitHubArchiveError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "GitHubArchiveError";
  }
}

/**
 * Starts streaming a repository's tarball archive at a specific commit —
 * `GET /repos/{owner}/{repo}/tarball/{ref}`, which GitHub's API redirects to
 * codeload.github.com. Returns the response body as a Node stream (not
 * buffered into memory) for the caller to pipe straight into extraction —
 * see docs/repository-ingestion.md's note on why this uses a tarball
 * download rather than `git clone`.
 */
export async function downloadRepositoryArchive(
  accessToken: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<Readable> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tarball/${encodeURIComponent(ref)}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "developer-platform",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: controller.signal,
      },
    );
  } catch (cause) {
    throw new GitHubArchiveError("Could not reach GitHub to download the repository archive", 502, cause);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const status = response.status === 404 ? 404 : response.status === 401 ? 401 : 502;
    throw new GitHubArchiveError(
      `GitHub responded with HTTP ${response.status} while downloading the repository archive`,
      status,
    );
  }

  if (!response.body) {
    throw new GitHubArchiveError("GitHub returned an empty archive response", 502);
  }

  return Readable.fromWeb(response.body as NodeWebReadableStream<Uint8Array>);
}
