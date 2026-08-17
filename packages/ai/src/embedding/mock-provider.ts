import { createHash } from "node:crypto";
import type { EmbeddingProvider, EmbeddingResult } from "./types.js";

/**
 * Deterministic, network-free `EmbeddingProvider` used by every unit/
 * integration test in this codebase (and available for local development
 * without an `OPENAI_API_KEY`) — see docs/semantic-search.md's "mocked vs.
 * real provider" section. Derives a fixed-dimension pseudo-embedding from
 * each text's SHA-256 hash: identical input always produces an identical
 * vector, different input reliably produces a different one, but the
 * vectors carry no real semantic meaning whatsoever — never used for
 * anything but tests and local dev without credentials.
 */
export function createMockEmbeddingProvider(
  options: { model?: string; dimensions?: number } = {},
): EmbeddingProvider {
  const model = options.model ?? "mock-embedding";
  const dimensions = options.dimensions ?? 32;

  return {
    model,
    dimensions,
    async embedDocuments(texts: string[]): Promise<EmbeddingResult[]> {
      return texts.map((text) => ({ vector: pseudoEmbedding(text, dimensions), model, dimensions }));
    },
  };
}

function pseudoEmbedding(text: string, dimensions: number): number[] {
  const vector: number[] = [];
  let seed = text;
  while (vector.length < dimensions) {
    const digest = createHash("sha256").update(seed).digest();
    for (let i = 0; i < digest.length && vector.length < dimensions; i += 1) {
      // Map each byte (0-255) to a small signed float centered on 0, so
      // cosine similarity between two vectors behaves sanely instead of
      // every vector pointing into the same all-positive octant.
      const byte = digest[i] ?? 0;
      vector.push(byte / 255 - 0.5);
    }
    seed = digest.toString("hex");
  }
  return vector;
}
