import { decryptToken as sharedDecrypt, encryptToken as sharedEncrypt } from "@developer-platform/shared";
import { env } from "../env.js";

/**
 * Thin, key-bound wrappers around the shared AES-256-GCM implementation
 * (packages/shared/src/crypto.ts). apps/api has an identical wrapper for
 * the same reason — kept so call sites don't need to thread the key through.
 */
export function encryptToken(plaintext: string): string {
  return sharedEncrypt(plaintext, env.GITHUB_TOKEN_ENCRYPTION_KEY);
}

export function decryptToken(encoded: string): string {
  return sharedDecrypt(encoded, env.GITHUB_TOKEN_ENCRYPTION_KEY);
}
