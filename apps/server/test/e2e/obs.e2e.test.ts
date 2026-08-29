import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_ID, OBS_ID, OBS_RETRY_MS, type CoreState } from "@saarathi/shared";
import { startFakeObs, type FakeObs } from "./helpers/fake-obs.js";
import { startServer, waitFor, type Client, type RunningServer } from "./helpers/server.js";

/**
 * The real server against a real obs-websocket peer.
 *
 * Everything here needs two processes and a socket to be true at all: whether
 * the auth string we compute is the one OBS wants, whether a refused password
 * stops the retry loop instead of hammering it, and whether a connection that
 * dies underneath us comes back. None of it is reachable from the kernel.
 */

let server: RunningServer | null = null;
let obs: FakeObs | null = null;
let carried: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = null;
  await obs?.close();
  obs = null;
  for (const dir of carried) rmSync(dir, { recursive: true, force: true });
  carried = [];
});

const coreOf = (client: Client) => client.latest(CORE_ID) as CoreState | undefined;
const obsStatusOf = (client: Client) => coreOf(client)?.connections[OBS_ID];

/**
 * Waits for OBS to reach a state, and says what it saw when it does not. The
 * generous default is because a retry here is a real OBS_RETRY_MS wait rather
 * than a timer we can advance -- this is the layer that runs in wall clock.
 */
async function until(
  client: Client,
  state: string,
  label = state,
  timeoutMs = 15_000,
): Promise<CoreState> {
  await client.waitFor(
    `obs ${label} (last: ${JSON.stringify(obsStatusOf(client))})`,
    () => obsStatusOf(client)?.state === state,
    timeoutMs,
  );
  return coreOf(client)!;
}

/** Points the running server at our fake OBS the way her control page would. */
async function point(client: Client, port: number, password: string) {
  return client.invoke({
    action: "core.obsSettings",
    args: ["127.0.0.1", String(port), password],
  });
}

describe("OBS control, end to end", () => {
  it("connects, authenticates, and reports her scenes", async () => {
    obs = await startFakeObs({ password: "s3cret", scenes: ["Workout", "Just Chatting", "BRB"] });
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    expect(await point(control, obs.port, "s3cret")).toEqual({ ok: true });
    const core = await until(control, "connected");

    expect(core.connections[OBS_ID]!.detail).toContain("3 scenes");
    // OBS hands the list back in the opposite order to its own indices, so the
    // fake does too, and getting these in her order is the adapter's job.
    expect(core.obs.scenes).toEqual(["BRB", "Just Chatting", "Workout"]);
    expect(core.obs.currentScene).toBe("Workout");
  });

  it("connects with no password when OBS is not asking for one", async () => {
    obs = await startFakeObs({ password: "" });
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    expect(await point(control, obs.port, "")).toEqual({ ok: true });
    await until(control, "connected");
  });

  it("switches a scene when she taps one, and follows OBS when she does not", async () => {
    obs = await startFakeObs({ password: "s3cret" });
    server = await startServer();
    const control = await server.connect({ surface: "control" });
    await point(control, obs.port, "s3cret");
    await until(control, "connected");

    expect(await control.invoke({ action: "core.obsScene", args: ["BRB"] })).toEqual({ ok: true });
    await waitFor("obs switched", () => obs!.switches.includes("BRB"));
    await control.waitFor("current scene follows", () => coreOf(control)?.obs.currentScene === "BRB");

    // And the other direction: OBS renaming its own list reaches her card
    // without her touching anything.
    obs.setScenes(["BRB", "Cooldown"]);
    await control.waitFor(
      "scene list follows OBS",
      () => coreOf(control)?.obs.scenes.join() === "Cooldown,BRB",
    );
  });

  it("refuses a scene OBS does not have, rather than asking it", async () => {
    obs = await startFakeObs({ password: "s3cret" });
    server = await startServer();
    const control = await server.connect({ surface: "control" });
    await point(control, obs.port, "s3cret");
    await until(control, "connected");

    expect(await control.invoke({ action: "core.obsScene", args: ["Nope"] })).toEqual({
      ok: false,
      reason: 'OBS has no scene called "Nope"',
    });
    expect(obs.switches).not.toContain("Nope");
  });

  it("stops retrying a password OBS refused, and says so", async () => {
    obs = await startFakeObs({ password: "right" });
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    await point(control, obs.port, "wrong");
    const core = await until(control, "error", "rejected");
    expect(core.connections[OBS_ID]!.detail).toContain("refused the password");

    // The point of the terminal state: nothing more happens on its own. A retry
    // loop here would hammer OBS every five seconds for the rest of the stream.
    control.clear();
    await expect(
      control.waitFor("a retry that should never come", () => control.patches.length > 0, 1_000),
    ).rejects.toThrow();

    // Until she fixes it, which is the way out.
    expect(await point(control, obs.port, "right")).toEqual({ ok: true });
    await until(control, "connected");
  });

  it("comes back when OBS quits and starts again", async () => {
    obs = await startFakeObs({ password: "s3cret" });
    const port = obs.port;
    server = await startServer();
    const control = await server.connect({ surface: "control" });
    await point(control, port, "s3cret");
    await until(control, "connected");

    await obs.close();
    obs = null;
    const down = await until(control, "disconnected", "dropped");
    expect(down.connections[OBS_ID]!.detail).toContain("Retrying");
    // Scenes are transient: a card that still lists them would offer buttons
    // that cannot work.
    expect(down.obs.scenes).toEqual([]);

    obs = await startFakeObs({ password: "s3cret", port });
    await until(control, "connected", "reconnected");
  });

  it("keeps the settings she saved across a restart", async () => {
    obs = await startFakeObs({ password: "s3cret" });
    server = await startServer();
    const first = await server.connect({ surface: "control" });
    await point(first, obs.port, "s3cret");
    await until(first, "connected");

    const { stateFile, stateDir } = server;
    if (stateDir) carried.push(stateDir);
    await server.stop({ keepState: true });

    server = await startServer({ stateFile });
    const second = await server.connect({ surface: "control" });
    const core = await until(second, "connected", "connected after a restart");

    expect(core.obs.mode).toBe("manual");
    expect(core.obs.port).toBe(obs.port);
    // She set it once; it is still there and it still never comes back to her.
    expect(core.obs.hasPassword).toBe(true);
    expect(JSON.stringify(core.obs)).not.toContain("s3cret");
  });

  it("finds OBS on its own from OBS's own config file", async () => {
    obs = await startFakeObs({ password: "generated-by-obs" });
    const dir = mkdtempSync(join(tmpdir(), "saarathi-obscfg-"));
    carried.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        first_load: false,
        server_enabled: true,
        server_port: obs.port,
        auth_required: true,
        server_password: "generated-by-obs",
      }),
    );

    server = await startServer({ env: { OBS_CONFIG: configPath } });
    const control = await server.connect({ surface: "control" });

    // Nothing was invoked. This is the whole feature: she ticks one checkbox in
    // OBS and the connection happens, with a password she never sees.
    const core = await until(control, "connected");
    expect(core.obs.mode).toBe("auto");
    expect(core.obs.detected).toBe(true);
    // The port her card shows is the one we are actually talking to. The OS
    // handed the fake a random one, so a card rendering the saved 4455 here
    // would be pointing her at a socket nothing is on.
    expect(core.obs.port).toBe(obs.port);
    // Hers, and she never set one: the field offers nothing to keep and the
    // Forget button nothing to forget, whatever OBS generated for itself.
    expect(core.obs.hasPassword).toBe(false);
  });

  it("stays off when she taps Disconnect, even mid-connect, until she taps try again", async () => {
    // Slow enough that the Disconnect below lands while the connect is still in
    // flight, which is the only window where an answer can arrive for a
    // connection she has already said she does not want.
    obs = await startFakeObs({ password: "s3cret", helloDelayMs: 400 });
    server = await startServer();
    const control = await server.connect({ surface: "control" });
    // Not awaited: this invoke does not answer until the attempt it starts is
    // over, and the whole point is to reach her Disconnect before then.
    const pointed = point(control, obs.port, "s3cret");
    await until(control, "connecting");

    expect(await control.invoke({ action: "core.obsDisconnect" })).toEqual({ ok: true });
    expect(await pointed).toEqual({ ok: true });
    const off = await until(control, "disconnected", "switched off");
    expect(off.connections[OBS_ID]!.detail).toContain("switched off");

    // Neither the connect she interrupted nor the retry loop may put it back:
    // a card that says off while the socket is open is worse than no card.
    await expect(
      control.waitFor(
        "a connection she did not ask for",
        () => obsStatusOf(control)?.state === "connected",
        // Past both the handshake she interrupted and a retry interval, and no
        // further: this one wait is most of what this file costs.
        OBS_RETRY_MS * 1.5,
      ),
    ).rejects.toThrow();

    // And the way back in.
    expect(await control.invoke({ action: "core.obsConnect" })).toEqual({ ok: true });
    await until(control, "connected", "connected again");
  });

  it("waits, without dialling, while OBS's WebSocket server is switched off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saarathi-obscfg-"));
    carried.push(dir);
    const configPath = join(dir, "config.json");
    const config = (enabled: boolean, port: number) =>
      writeFileSync(
        configPath,
        JSON.stringify({
          server_enabled: enabled,
          server_port: port,
          auth_required: false,
          server_password: "",
        }),
      );

    obs = await startFakeObs({ password: "" });
    config(false, obs.port);

    server = await startServer({ env: { OBS_CONFIG: configPath } });
    const control = await server.connect({ surface: "control" });

    const off = await until(control, "disconnected", "waiting on the checkbox");
    expect(off.connections[OBS_ID]!.detail).toContain("Tools → WebSocket Server Settings");

    // The file is re-read on every attempt, so ticking the box in OBS is enough
    // and she never restarts anything.
    config(true, obs.port);
    await until(control, "connected", "connected once the box was ticked");
  });
});
