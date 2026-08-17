import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM encrypt/decrypt for secrets stored at rest (GitHub access
 * tokens today). Shared between apps/api (which creates GitHubAccount rows
 * on OAuth callback) and apps/worker (which decrypts the token to call the
 * GitHub API during ingestion) so the ciphertext format and algorithm live
 * in exactly one place. Each caller supplies its own already-validated
 * `GITHUB_TOKEN_ENCRYPTION_KEY` — this module doesn't read env itself, so
 * it stays usable from either process without an env-schema dependency.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, standard for GCM
const AUTH_TAG_LENGTH = 16;

function toKeyBuffer(key: string | Buffer): Buffer {
  return typeof key === "string" ? Buffer.from(key, "base64") : key;
}

/**
 * Encrypts a secret for storage at rest, using AES-256-GCM (authenticated
 * encryption — tampering with the ciphertext is detected, not just
 * decrypted into garbage).
 *
 * Output is base64(iv || authTag || ciphertext), self-contained so
 * `decryptToken` doesn't need anything beyond the key and this one string.
 */
export function encryptToken(plaintext: string, key: string | Buffer): string {
  const keyBuffer = toKeyBuffer(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Reverses `encryptToken`. Throws if the ciphertext was tampered with or
 * encrypted under a different key — callers should treat that as "the
 * stored secret is unusable," not attempt to recover a partial value.
 */
export function decryptToken(encoded: string, key: string | Buffer): string {
  const keyBuffer = toKeyBuffer(key);
  const raw = Buffer.from(encoded, "base64");
  if (raw.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Ciphertext is too short to be a valid encrypted token");
  }

  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
