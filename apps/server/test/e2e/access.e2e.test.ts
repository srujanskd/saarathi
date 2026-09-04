import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_ACTIONS, GAINS, type Snapshot } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

describe("HTTP access", () => {
  it("leaves health public and protects state", async () => {
    expect((await server.raw("/health")).status).toBe(200);
    expect((await server.raw("/api/state")).status).toBe(401);
  });

  it("lets an overlay read state but not invoke", async () => {
    const headers = { authorization: `Bearer ${server.overlayToken}` };
    const state = await server.raw("/api/state", { headers });
    expect(state.status).toBe(200);
    const snapshot = (await state.json()) as Snapshot;
    expect(Object.keys(snapshot.modules).sort()).toEqual(["gains", "goals", "media", "wheel"]);
    expect(snapshot.core.chat).toEqual({});
    expect(snapshot.core.deck.slots).toEqual([]);
    expect((await server.raw("/api/invoke", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ action: CORE_ACTIONS.deckSet, args: ["[]"] }),
    })).status).toBe(401);
  });

  it("lists overlays from server declarations for the home page", async () => {
    const response = await server.raw("/api/overlays", {
      headers: { authorization: `Bearer ${server.overlayToken}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      overlays: [
        { id: "wheel", title: "Challenge wheel" },
        { id: "goals", title: "Goals" },
        { id: "gains", title: `Earning ${GAINS.plural}` },
        { id: "media", title: "Media" },
      ],
    });
  });

  it("exchanges the tray code for control access", async () => {
    const response = await server.raw("/api/access/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: server.pairingCode }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ controlToken: server.controlToken });
  });
});

describe("socket access", () => {
  it("rejects a socket with no capability", async () => {
    await expect(server.connect({ surface: "control" }, "none")).rejects.toThrow("Pair this device");
  });

  it("limits an overlay to declared overlay slices and refuses invokes", async () => {
    const overlay = await server.connect(
      { surface: "overlay", modules: ["wheel", "moderation", "chatlog"] },
      "read",
    );
    const snapshot = overlay.snapshots.at(-1) as Snapshot;
    expect(Object.keys(snapshot.modules)).toEqual(["wheel"]);
    expect(snapshot.core.chat).toEqual({});
    await expect(overlay.invoke({ action: "wheel.spin" })).resolves.toEqual({
      ok: false,
      reason: "This link can only show overlays",
    });
    await overlay.close();
  });

  it("keeps full control for a paired phone", async () => {
    const control = await server.connect({ surface: "control", modules: ["wheel"] });
    expect(Object.keys(control.snapshots.at(-1)!.modules)).toEqual(["wheel"]);
    await expect(control.invoke({ action: "wheel.spin" })).resolves.toEqual({ ok: true });
    await control.close();
  });
});
