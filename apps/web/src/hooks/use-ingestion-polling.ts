"use client";

import { useEffect, useState } from "react";
// Value import from the `/ingestion` subpath, not the package's main
// barrel — see apps/web/src/lib/api.ts's comment on the Turbopack barrel
// value-export bug this sidesteps.
import { isActiveIngestionStatus } from "@developer-platform/shared/ingestion";
import type { IngestionDto } from "@developer-platform/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 2000;

/**
 * Polls GET /ingestions/:id every 2s while the ingestion is in an active
 * state, stopping automatically once it reaches a terminal one (COMPLETED/
 * FAILED/CANCELLED) — this project deliberately doesn't have SSE/WebSocket
 * infrastructure yet (see docs/repository-ingestion.md), so polling is a
 * conscious, documented simplification for Phase 3, not an oversight.
 *
 * `initialData` seeds only the very first render (e.g. from the server-
 * rendered repository detail page) so there's no loading flash — it's read
 * once via useState's lazy initializer, deliberately not re-applied when
 * `ingestionId` changes later (e.g. right after starting a new ingestion),
 * since re-syncing stale initial data into state on every id change is
 * exactly the synchronous-setState-in-an-effect pattern React (and this
 * project's react-hooks lint rule) warns against. A fresh id just starts
 * polling and picks up real data as soon as the first request resolves.
 */
export function useIngestionPolling(
  ingestionId: string | null,
  initialData: IngestionDto | null = null,
): IngestionDto | null {
  const [ingestion, setIngestion] = useState<IngestionDto | null>(() => initialData);

  useEffect(() => {
    if (!ingestionId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`${API_URL}/ingestions/${ingestionId}`, { credentials: "include" });
        if (response.ok) {
          const data = (await response.json()) as IngestionDto;
          if (cancelled) return;
          setIngestion(data);
          if (isActiveIngestionStatus(data.status)) {
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

    // Skip the network entirely if we already know (from the seeded initial
    // data) that this ingestion is already done.
    if (!initialData || isActiveIngestionStatus(initialData.status)) {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // `initialData` intentionally excluded — it only seeds the first paint;
    // re-running this effect should be driven by a genuinely new ingestionId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ingestionId]);

  return ingestion;
}
