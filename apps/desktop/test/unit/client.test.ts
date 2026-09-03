import { afterEach, describe, expect, it, vi } from "vitest";
import { localAccess, localPairing, reconnectLocalAccess, ServerClient } from "../../src/client.js";

afterEach(() => vi.useRealTimers());

describe("local server access", () => {
  it("does not open a pairing window for a background client", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ controlToken: "control", overlayToken: "read" })),
    );
    await expect(localAccess(4400, request)).resolves.toEqual({
      controlToken: "control",
      overlayToken: "read",
    });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:4400/api/access/local");
  });

  it("asks for a fresh pairing window when Connect opens", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        controlToken: "control",
        overlayToken: "read",
        pairing: { code: "123456", expiresAt: 601_000 },
      })),
    );
    await expect(localPairing(4400, true, request)).resolves.toMatchObject({
      pairing: { code: "123456" },
    });
    expect(request).toHaveBeenCalledWith("http://127.0.0.1:4400/api/access/local?pairing=fresh");
  });

  it("reacquires loopback access after the server revokes the socket", async () => {
    const request = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ controlToken: "rotated", overlayToken: "read" })),
    );
    const socket = { auth: { token: "old" }, connect: vi.fn() };
    await expect(reconnectLocalAccess(4400, socket, request)).resolves.toBe(true);
    expect(socket.auth).toEqual({ token: "rotated" });
    expect(socket.connect).toHaveBeenCalledOnce();
  });

  it("retries bootstrap when the child is not listening yet", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error("not listening"));
    const client = new ServerClient({
      port: 4400,
      request,
      retryMs: 10,
      onCore: vi.fn(),
      onState: vi.fn(),
      log: vi.fn(),
    });
    client.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(request).toHaveBeenCalledTimes(2);
    client.stop();
  });
});
