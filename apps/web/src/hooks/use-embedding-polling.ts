"use client";

import { useEffect, useState } from "react";
// Value import from the `/embedding` subpath, not the package's main
// barrel — same Turbopack barrel value-export workaround as
// use-analysis-polling.ts / use-ingestion-polling.ts.
import { isActiveEmbeddingStatus } from "@developer-platform/shared/embedding";
import type { EmbeddingRunDto } from "@developer-platform/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 2000;

/**
 * Polls GET /embeddings/:id every 2s while the run is in an active state,
 * stopping automatically once it reaches a terminal one — same documented
 * simplification (no SSE/WebSocket infrastructure yet) as
 * use-analysis-polling.ts/use-ingestion-polling.ts, and the same lazy-
 * initializer treatment of `initialData` for the same reason (see
 * use-ingestion-polling.ts's doc comment).
 */
export function useEmbeddingPolling(
  embeddingId: string | null,
  initialData: EmbeddingRunDto | null = null,
): EmbeddingRunDto | null {
  const [embedding, setEmbedding] = useState<EmbeddingRunDto | null>(() => initialData);

  useEffect(() => {
    if (!embeddingId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`${API_URL}/embeddings/${embeddingId}`, { credentials: "include" });
        if (response.ok) {
          const data = (await response.json()) as EmbeddingRunDto;
          if (cancelled) return;
          setEmbedding(data);
          if (isActiveEmbeddingStatus(data.status)) {
            timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
          }
          return;
        }
      } catch {
        // network blip — fall through and retry on the next tick rather than giving up
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    }

    if (!initialData || isActiveEmbeddingStatus(initialData.status)) {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embeddingId]);

  return embedding;
}
