"use client";

import { useEffect, useState } from "react";
// Value import from the `/analysis` subpath, not the package's main barrel
// — same Turbopack barrel value-export workaround as use-ingestion-polling.ts.
import { isActiveAnalysisStatus } from "@developer-platform/shared/analysis";
import type { AnalysisRunDto } from "@developer-platform/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 2000;

/**
 * Polls GET /analyses/:id every 2s while the run is in an active state,
 * stopping automatically once it reaches a terminal one — same documented
 * simplification as use-ingestion-polling.ts (no SSE/WebSocket
 * infrastructure yet). See that hook's doc comment for why `initialData`
 * is read once via a lazy initializer rather than re-applied on id change.
 */
export function useAnalysisPolling(
  analysisId: string | null,
  initialData: AnalysisRunDto | null = null,
): AnalysisRunDto | null {
  const [analysis, setAnalysis] = useState<AnalysisRunDto | null>(() => initialData);

  useEffect(() => {
    if (!analysisId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`${API_URL}/analyses/${analysisId}`, { credentials: "include" });
        if (response.ok) {
          const data = (await response.json()) as AnalysisRunDto;
          if (cancelled) return;
          setAnalysis(data);
          if (isActiveAnalysisStatus(data.status)) {
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

    if (!initialData || isActiveAnalysisStatus(initialData.status)) {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysisId]);

  return analysis;
}
