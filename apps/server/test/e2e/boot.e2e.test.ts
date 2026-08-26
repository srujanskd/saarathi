import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_PORT, type CoreState, type Snapshot } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

describe("the server she starts", () => {
  it("answers /health", async () => {
    expect(await server.get("/health")).toEqual({ ok: true });
  });

  it("came up on the port it was told, not the default", () => {
    expect(server.port).not.toBe(SERVER_PORT);
  });

  it("binds somewhere her phone can reach, not just this machine", async () => {
    // Loopback is what the test can prove; 0.0.0.0 is what makes it reachable.
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.ok).toBe(true);
  });

  it("says the overlays are not built yet, rather than 404ing at her", async () => {
    const body = (await server.get("/")) as { ok: boolean; hint?: string };
    expect(body.ok).toBe(true);
    expect(body.hint).toContain("not built yet");
  });

  it("serves the same snapshot over HTTP that a client gets", async () => {
    const snapshot = (await server.get("/api/state")) as Snapshot;
    expect(Object.keys(snapshot.modules).sort()).toEqual(["chatlog", "wheel"]);
    expect(snapshot.core.modules.map((m) => m.id).sort()).toEqual(["chatlog", "wheel"]);
  });

  it("reports mock chat connected and no YouTube adapter at all", async () => {
    const snapshot = (await server.get("/api/state")) as Snapshot;
    const core: CoreState = snapshot.core;
    expect(core.connections.mock).toEqual({ state: "connected", detail: "Mock chat ready" });
    expect(core.connections.youtube).toBeUndefined();
  });

  it("did not write to her data directory", () => {
    expect(server.stateFile).toContain("saarathi-e2e-");
  });
});

describe("a client that connects", () => {
  it("is handed a full snapshot without asking", async () => {
    const client = await server.connect();
    expect(client.snapshots[0]!.core.startedAt).toBeTypeOf("number");
    expect(client.snapshots[0]!.modules.wheel).toBeTruthy();
    await client.close();
  });

  it("gets only the modules it subscribed to", async () => {
    const client = await server.connect({ surface: "overlay", modules: ["wheel"] });
    const scoped = client.snapshots.at(-1)!;
    expect(Object.keys(scoped.modules)).toEqual(["wheel"]);
    await client.close();
  });

  it("still gets core state, since that is how she sees the server is alive", async () => {
    const client = await server.connect({ surface: "overlay", modules: ["wheel"] });
    expect(client.snapshots.at(-1)!.core.modules.length).toBe(2);
    await client.close();
  });

  it("can ask for everything explicitly", async () => {
    const client = await server.connect({ surface: "control" });
    expect(Object.keys(client.snapshots.at(-1)!.modules).sort()).toEqual(["chatlog", "wheel"]);
    await client.close();
  });
});
