import { describe, expect, it, vi } from "vitest";
import { withTimeout } from "../../src/core/obs.js";

/**
 * The clock obs-websocket-js does not have. Both places we call it -- opening
 * the socket, and every request over it -- fail the same way without one: they
 * do not fail at all, they wait for the rest of the stream.
 */
describe("withTimeout", () => {
  it("gives back what the work gave back, and stops its own timer", async () => {
    vi.useFakeTimers();
    try {
      await expect(withTimeout(Promise.resolve("scenes"), 1_000, "too slow")).resolves.toBe(
        "scenes",
      );
      // A timer left running here would hold the process open for as long as
      // the timeout, on every single call.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a real failure through rather than relabelling it", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("connection refused")), 1_000, "too slow"),
    ).rejects.toThrow("connection refused");
  });

  it("gives up on work that never answers, and says so in her words", async () => {
    vi.useFakeTimers();
    try {
      const hangs = withTimeout(new Promise(() => {}), 5_000, "OBS did not answer within 5s");
      const settled = expect(hangs).rejects.toThrow("OBS did not answer within 5s");
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
