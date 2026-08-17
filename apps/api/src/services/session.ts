import { randomBytes, createHash } from "node:crypto";
import { prisma } from "@developer-platform/database";
import type { User } from "@prisma/client";

/**
 * How long a session lasts before it must be re-established via GitHub
 * login again. Chosen so `docker compose down && up` during normal
 * development doesn't constantly log people out, without being unbounded.
 */
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * The browser only ever sees this raw, high-entropy random token. The
 * database stores only its SHA-256 hash (`Session.tokenHash`) — a database
 * leak alone can't be used to forge or replay a session, the same principle
 * as hashing passwords, applied to bearer tokens.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

/** Creates a new session row and returns the raw token to set as a cookie. */
export async function createSession(userId: string): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { userId, tokenHash: hashToken(token), expiresAt },
  });

  return { token, expiresAt };
}

/**
 * Resolves a raw session token (from the request cookie) to its user.
 * Returns `null` for a missing, unknown, or expired session — callers don't
 * need to distinguish those cases, they're all "not authenticated."
 */
export async function getUserForSessionToken(token: string): Promise<User | null> {
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  return session.user;
}

/** Deletes the session server-side (logout). Safe to call with an unknown token. */
export async function destroySessionByToken(token: string): Promise<void> {
  await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}
