import { decryptToken as sharedDecrypt, encryptToken as sharedEncrypt } from "@developer-platform/shared";
import { env } from "../env.js";

/**
 * Thin, key-bound wrappers around the shared AES-256-GCM implementation
 * (packages/shared/src/crypto.ts) — kept so existing call sites
 * (`encryptToken(token)`) don't need to thread the key through everywhere.
 * apps/worker has an identical wrapper for the same reason.
 */
export function encryptToken(plaintext: string): string {
  return sharedEncrypt(plaintext, env.GITHUB_TOKEN_ENCRYPTION_KEY);
}

export function decryptToken(encoded: string): string {
  return sharedDecrypt(encoded, env.GITHUB_TOKEN_ENCRYPTION_KEY);
}
