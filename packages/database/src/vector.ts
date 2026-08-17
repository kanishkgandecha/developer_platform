/**
 * pgvector's text input/output format for a `vector` column is a bracketed,
 * comma-separated list of numbers — `[0.1,0.2,...]`. Prisma Client has no
 * native understanding of the `vector` type (see CodeChunk's `embedding`
 * field, `Unsupported("vector(1536)")` in schema.prisma), so every read or
 * write of it goes through `$queryRaw`/`$executeRaw` with an explicit
 * `::vector` cast — this is the one place that literal is built, shared by
 * apps/worker (persisting embeddings) and apps/api (querying them), so the
 * format can't drift between the two.
 */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const value of vector) {
    if (!Number.isFinite(value)) {
      throw new Error("Cannot build a pgvector literal from a non-finite number");
    }
  }
  return `[${vector.join(",")}]`;
}
