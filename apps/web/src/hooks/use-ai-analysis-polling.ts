"use client";

import { useEffect, useState } from "react";
// Value import from the `/ai-analysis` subpath, not the package's main
// barrel — same Turbopack barrel value-export workaround as every other
// polling hook in this codebase.
import { isActiveAIAnalysisStatus } from "@developer-platform/shared/ai-analysis";
import type { AIAnalysisRunDto } from "@developer-platform/shared";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const POLL_INTERVAL_MS = 2000;

/**
 * Polls GET /ai-analysis/:id every 2s while the run is active, stopping
 * automatically once it reaches a terminal state — same documented
 * simplification (no SSE/WebSocket infrastructure yet) as every other
 * polling hook in this codebase.
 */
export function useAIAnalysisPolling(
  aiAnalysisId: string | null,
  initialData: AIAnalysisRunDto | null = null,
): AIAnalysisRunDto | null {
  const [aiAnalysis, setAIAnalysis] = useState<AIAnalysisRunDto | null>(() => initialData);

  useEffect(() => {
    if (!aiAnalysisId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const response = await fetch(`${API_URL}/ai-analysis/${aiAnalysisId}`, { credentials: "include" });
        if (response.ok) {
          const data = (await response.json()) as AIAnalysisRunDto;
          if (cancelled) return;
          setAIAnalysis(data);
          if (isActiveAIAnalysisStatus(data.status)) {
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

    if (!initialData || isActiveAIAnalysisStatus(initialData.status)) {
      void poll();
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiAnalysisId]);

  return aiAnalysis;
}
