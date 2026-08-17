import { PrismaClient } from "@prisma/client";

/**
 * Single shared PrismaClient instance for the whole process. In dev, Next.js
 * / tsx hot-reloads can otherwise spawn a new client (and a new connection
 * pool) on every reload, so we stash it on `globalThis` and reuse it.
 */
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export { PrismaClient } from "@prisma/client";
export * from "./vector.js";

/**
 * Cheap connectivity check used by the API's /health endpoint. Runs a real
 * query (not just a TCP ping) so it actually proves Prisma <-> Postgres.
 */
export async function checkDatabaseConnection(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
