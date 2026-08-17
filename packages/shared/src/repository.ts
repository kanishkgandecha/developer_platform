import type { IngestionDto } from "./ingestion.js";

/**
 * Repository metadata shape shared between apps/api's responses and
 * apps/web's rendering — deliberately just the fields listed in
 * docs/architecture.md's Repository model, not the full GitHub API payload.
 */
export interface RepositoryDto {
  id: string;
  githubId: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  htmlUrl: string;
  description: string | null;
  updatedAt: string;
  /**
   * The most recent ingestion attempt for this repository, if any —
   * embedded so the repositories list can show real status without an
   * extra request per row. `null` means "never ingested."
   */
  latestIngestion: IngestionDto | null;
}
