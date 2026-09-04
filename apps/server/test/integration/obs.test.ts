import { afterEach, describe, expect, it } from "vitest";
import { CORE_ACTIONS, CORE_ID, OBS_ID } from "@saarathi/shared";
import { fakeObs, harness, type FakeObs, type Harness } from "../helpers/kernel.js";

/**
 * OBS as the kernel sees it: a core connection whose comings and goings reach
 * her control page, and a set of core actions her surfaces can invoke. What
 * happens on the wire to OBS itself is the e2e layer's job.
 */

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

async function start(obs: FakeObs = fakeObs()) {
  live = await harness({ obs });
  return { h: live, obs };
}

const core = (h: Harness) => h.kernel.coreState();
const status = (h: Harness) => core(h).connections[OBS_ID];

describe("OBS is a core connection", () => {
  it("appears beside the chat adapters, keyed by name", async () => {
    const { h } = await start();
    expect(Object.keys(core(h).connections)).toContain(OBS_ID);
    expect(status(h)!.state).toBe("disconnected");
  });

  it("puts the OBS view in the core slice from the first snapshot", async () => {
    const { h } = await start();
    expect(h.kernel.snapshot().core.obs).toMatchObject({ scenes: [], currentScene: null });
  });

  it("patches core when OBS arrives and when it goes away", async () => {
    const { h, obs } = await start();
    h.seen.clear();

    obs.arrive(["Workout", "BRB"]);
    expect(status(h)!.state).toBe("connected");
    expect(core(h).obs.scenes).toEqual(["Workout", "BRB"]);
    expect(h.seen.patches.some((patch) => patch.module === CORE_ID)).toBe(true);

    obs.depart();
    expect(status(h)!.state).toBe("disconnected");
    // Scenes go with it: buttons for scenes we can no longer reach are worse
    // than no buttons.
    expect(core(h).obs.scenes).toEqual([]);
  });

  it("never puts the password in the slice a client receives", async () => {
    const { h } = await start();
    expect(Object.keys(core(h).obs)).not.toContain("password");
  });
});

describe("her surfaces drive OBS through core actions", () => {
  it("switches a scene", async () => {
    const { h, obs } = await start();
    obs.arrive(["Workout", "BRB"]);

    expect(await h.kernel.invoke("core.obsScene", { args: ["BRB"] })).toEqual({ ok: true });
    expect(obs.scenes).toEqual(["BRB"]);
  });

  it("routes named microphone controls through the OBS connection", async () => {
    const { h, obs } = await start();
    obs.arrive(["Workout"], [{ name: "Mic/Aux", muted: false }]);

    expect(await h.kernel.invoke(CORE_ACTIONS.obsMute, { args: ["Mic/Aux"] })).toEqual({
      ok: true,
    });
    expect(core(h).obs.microphones[0]?.muted).toBe(true);
    expect(await h.kernel.invoke(CORE_ACTIONS.obsUnmute, { args: ["Mic/Aux"] })).toEqual({
      ok: true,
    });
    expect(obs.microphoneChanges).toEqual([
      { name: "Mic/Aux", muted: true },
      { name: "Mic/Aux", muted: false },
    ]);
  });

  it("refuses a microphone OBS did not name", async () => {
    const { h, obs } = await start();
    obs.arrive(["Workout"], [{ name: "Mic/Aux", muted: false }]);

    expect(await h.kernel.invoke(CORE_ACTIONS.obsMute, { args: ["Guest mic"] })).toEqual({
      ok: false,
      reason: 'OBS has no microphone called "Guest mic"',
    });
    expect(obs.microphoneChanges).toEqual([]);
  });

  it("creates and removes only server-declared overlays", async () => {
    const { h, obs } = await start();
    obs.arrive(["Workout"]);

    expect(
      await h.kernel.invoke("core.obsBrowserSource", {
        args: ["wheel", "http://192.168.1.20:4400"],
      }, { serverHost: "192.168.1.20:4400" }),
    ).toEqual({ ok: true });
    expect(obs.browserSourceChanges).toEqual([
      {
        operation: "create",
        overlay: {
          id: "wheel",
          title: "Challenge wheel",
          sourceName: "Saarathi wheel",
        },
        serverUrl: "http://192.168.1.20:4400",
      },
    ]);

    expect(
      await h.kernel.invoke("core.obsRemoveBrowserSource", { args: ["wheel"] }),
    ).toEqual({ ok: true });
    expect(obs.browserSourceChanges.at(-1)).toMatchObject({
      operation: "remove",
      overlay: { id: "wheel" },
    });

    expect(
      await h.kernel.invoke("core.obsBrowserSource", {
        args: ["chatlog", "http://192.168.1.20:4400"],
      }, { serverHost: "192.168.1.20:4400" }),
    ).toEqual({ ok: false, reason: 'There is no overlay "chatlog"' });
  });

  it("refuses to send the overlay capability to a different host", async () => {
    const { h, obs } = await start();
    obs.arrive(["Workout"]);

    expect(
      await h.kernel.invoke(
        "core.obsBrowserSource",
        { args: ["wheel", "https://attacker.example"] },
        { serverHost: "192.168.1.20:4400" },
      ),
    ).toEqual({
      ok: false,
      reason: "That server address does not match this Saarathi connection",
    });
    expect(obs.browserSourceChanges).toEqual([]);
  });

  it("says why, rather than nothing, when OBS is not there", async () => {
    const { h } = await start();
    expect(await h.kernel.invoke("core.obsScene", { args: ["BRB"] })).toEqual({
      ok: false,
      reason: "OBS is not connected",
    });
  });

  it("saves settings from her control page", async () => {
    const { h, obs } = await start();
    expect(await h.kernel.invoke("core.obsSettings", { args: ["10.0.0.5", "4455", "pw"] })).toEqual({
      ok: true,
    });
    expect(obs.saves).toEqual([{ host: "10.0.0.5", port: 4455, password: "pw" }]);
  });

  // Parsing happens once, at the seam, so nothing past it holds a port that is
  // not a number -- and she is told which of the three fields is wrong.
  it("refuses a port that is not one, and saves nothing", async () => {
    const { h, obs } = await start();
    expect(await h.kernel.invoke("core.obsSettings", { args: ["10.0.0.5", "half", ""] })).toEqual({
      ok: false,
      reason: '"half" is not a port number. OBS uses 4455 by default.',
    });
    expect(obs.saves).toEqual([]);
  });

  it("has a way out of every way in", async () => {
    const { h } = await start();
    for (const action of ["core.obsConnect", "core.obsDisconnect", "core.obsAuto", "core.obsForget"]) {
      expect(await h.kernel.invoke(action)).toEqual({ ok: true });
    }
  });

  // The guard that used to resolve a module from args[0] before the switch ran
  // refused every core action that is not about a module -- which, once OBS
  // arrived, was most of them.
  it("still refuses a core action that does not exist", async () => {
    const { h } = await start();
    expect(await h.kernel.invoke("core.nonsense", { args: ["wheel"] })).toEqual({
      ok: false,
      reason: 'There is no core action "nonsense"',
    });
  });

  it("still names the module a lifecycle action could not find", async () => {
    const { h } = await start();
    expect(await h.kernel.invoke("core.enable", { args: ["nope"] })).toEqual({
      ok: false,
      reason: 'There is no "nope"',
    });
  });
});

describe("modules reach OBS through ctx.obs and nothing else", () => {
  it("hands a module the narrow actions, not the adapter", async () => {
    const { obs } = await start();
    obs.arrive();

    // What a module holds is ObsActions: it can act, and it cannot reconfigure
    // the connection or read her password.
    const actions = obs.actions;
    expect(Object.keys(actions).sort()).toEqual(["connected", "setScene", "setSourceVisible"]);

    await actions.setSourceVisible("Workout", "Camera", false);
    expect(obs.visibility).toEqual([{ scene: "Workout", source: "Camera", visible: false }]);
  });
});
