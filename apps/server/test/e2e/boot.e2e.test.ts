import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SERVER_PORT, type CoreState, type Snapshot } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer;

beforeAll(async () => {
  // Pointed at nothing on purpose: whether someone has run `pnpm build` on
  // this machine is not allowed to decide what these tests assert.
  server = await startServer({ env: { OVERLAYS_DIST: join(tmpdir(), "saarathi-no-such-dist") } });
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
    expect(Object.keys(snapshot.modules).sort()).toEqual(["chatlog", "goals", "wheel"]);
    expect(snapshot.core.modules.map((m) => m.id).sort()).toEqual(["chatlog", "goals", "wheel"]);
  });

  it("reports mock chat connected and YouTube waiting to be set up", async () => {
    // YouTube is registered on every run now, because she sets her channel up
    // from her phone and an adapter that only exists when an env var is set is
    // one she can never switch on. With nothing set it says so, which is a
    // status she can act on rather than a silence.
    const snapshot = (await server.get("/api/state")) as Snapshot;
    const core: CoreState = snapshot.core;
    expect(core.connections.mock).toEqual({ state: "connected", detail: "Mock chat ready" });
    expect(core.connections.youtube!.detail).toContain("No YouTube channel set yet");
    expect(core.chat.youtube).toMatchObject({ channelId: "", hasKey: false });
    // Mock chat has nothing to set up, so it is absent here rather than empty.
    expect(core.chat.mock).toBeUndefined();
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

  /**
   * A client is not necessarily on the server's machine -- `?server=` exists so
   * it can be a VPS while the page runs on her phone -- and every timestamp in
   * the state is server time. Without this field a phone whose clock is out
   * subtracts the wrong `now` from `spin.startedAt` and gets an elapsed that is
   * tens of seconds wrong, which for a six second spin means it renders as
   * already finished.
   */
  it("is told the server's clock, so it can correct its own", async () => {
    const before = Date.now();
    const client = await server.connect();
    const after = Date.now();

    const serverNow = client.snapshots[0]!.serverNow;
    expect(serverNow).toBeTypeOf("number");
    // Both processes are on this machine, so the stamp has to sit inside the
    // window we measured around the connect.
    expect(serverNow).toBeGreaterThanOrEqual(before);
    expect(serverNow).toBeLessThanOrEqual(after);
    await client.close();
  });

  it("is told it again on reconnect, because that is when it could have drifted", async () => {
    const first = await server.connect();
    const before = first.snapshots[0]!.serverNow;
    // OBS reloading the browser source: the old socket is simply gone.
    await first.close();

    const reloaded = await server.connect();
    expect(reloaded.snapshots[0]!.serverNow).toBeGreaterThanOrEqual(before);
    await reloaded.close();
  });

  it("gets only the modules it subscribed to", async () => {
    const client = await server.connect({ surface: "overlay", modules: ["wheel"] });
    const scoped = client.snapshots.at(-1)!;
    expect(Object.keys(scoped.modules)).toEqual(["wheel"]);
    await client.close();
  });

  it("still gets core state, since that is how she sees the server is alive", async () => {
    const client = await server.connect({ surface: "overlay", modules: ["wheel"] });
    expect(client.snapshots.at(-1)!.core.modules.length).toBe(3);
    await client.close();
  });

  it("can ask for everything explicitly", async () => {
    const client = await server.connect({ surface: "control" });
    expect(Object.keys(client.snapshots.at(-1)!.modules).sort()).toEqual(["chatlog", "goals", "wheel"]);
    await client.close();
  });
});

describe("once the overlay pages are built", () => {
  let dir: string;
  let built: RunningServer;

  beforeAll(async () => {
    // Her whole setup is one address: OBS and her phone both point at the
    // server, and the server hands them the pages.
    dir = mkdtempSync(join(tmpdir(), "saarathi-dist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Saarathi</title>");
    writeFileSync(join(dir, "overlay.html"), "<!doctype html><title>overlay</title>");
    writeFileSync(join(dir, "control.html"), "<!doctype html><title>control</title>");
    built = await startServer({ env: { OVERLAYS_DIST: dir } });
  });

  afterAll(async () => {
    await built?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves them, so OBS and her phone need one address and not two", async () => {
    const overlay = await fetch(`${built.origin}/overlay.html`);
    expect(overlay.status).toBe(200);
    expect(await overlay.text()).toContain("<title>overlay</title>");

    const control = await fetch(`${built.origin}/control.html`);
    expect(control.status).toBe(200);
    expect(await control.text()).toContain("<title>control</title>");
  });

  it("still answers the API underneath them", async () => {
    expect(await built.get("/health")).toEqual({ ok: true });
    const snapshot = (await built.get("/api/state")) as Snapshot;
    expect(Object.keys(snapshot.modules).sort()).toEqual(["chatlog", "goals", "wheel"]);
  });
});
