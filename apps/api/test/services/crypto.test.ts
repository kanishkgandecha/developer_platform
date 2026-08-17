import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../../src/services/crypto.js";

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const plaintext = "gho_realisticLookingGitHubTokenValue1234567890";
    expect(decryptToken(encryptToken(plaintext))).toBe(plaintext);
  });

  it("produces different ciphertext for the same plaintext each time (random IV)", () => {
    const plaintext = "same-input";
    expect(encryptToken(plaintext)).not.toBe(encryptToken(plaintext));
  });

  it("never contains the plaintext in the ciphertext output", () => {
    const plaintext = "super-secret-github-token";
    expect(encryptToken(plaintext)).not.toContain(plaintext);
  });

  it("throws (rather than silently returning garbage) when ciphertext is tampered with", () => {
    const encrypted = encryptToken("a-token-worth-protecting");
    const raw = Buffer.from(encrypted, "base64");
    // Flip a byte inside the ciphertext region (after the 12-byte IV and
    // 16-byte auth tag) — GCM's auth tag must fail to verify.
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
    const tampered = raw.toString("base64");

    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws when decrypted under the wrong key material shape (garbage input)", () => {
    expect(() => decryptToken("not-valid-base64-ciphertext-at-all")).toThrow();
  });
});
