/**
 * Mirrors Prisma's `FileCategory` enum (packages/database/prisma/schema.prisma).
 * Duplicated, not imported from @prisma/client, so this package stays
 * dependency-free and usable from anywhere without pulling in Prisma.
 */
export type FileCategory =
  | "SOURCE"
  | "CONFIG"
  | "DOCUMENTATION"
  | "DATA"
  | "BINARY"
  | "GENERATED"
  | "IGNORED";

export interface FileClassification {
  category: FileCategory;
  language: string | null;
  isSource: boolean;
  isIgnored: boolean;
}
