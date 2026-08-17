import { describe, expect, it } from "vitest";
import { mapWithConcurrencyLimit } from "../../src/ai-analysis/concurrency.js";

describe("mapWithConcurrencyLimit", () => {
  it("runs every item and preserves result order", async () => {
    const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrencyLimit(items, 3, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return n;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it("handles an empty item list", async () => {
    const results = await mapWithConcurrencyLimit([], 3, async (n: number) => n);
    expect(results).toEqual([]);
  });

  it("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrencyLimit([1, 2], 10, async (n) => n);
    expect(results).toEqual([1, 2]);
  });

  it("propagates a task's rejection", async () => {
    await expect(
      mapWithConcurrencyLimit([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });
});
