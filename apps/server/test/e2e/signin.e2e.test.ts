import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CORE_ACTIONS, type ChatSignInView, type Snapshot } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

/**
 * The sign-in as it looks over a real socket, from the real server.
 *
 * Deliberately not the flow: signing in means talking to Google, and a spec
 * that did would either need her account or reach the internet from CI. That
 * half is scripted one tier down, in `integration/chat-signin.test.ts`.
 *
 * What only this tier can prove is the part that has nothing to do with Google:
 * that the four new action ids survive the trip through HTTP and the socket and
 * reach the adapter, that the slice a client is handed on connect carries the
 * sign-in section for the adapter that has one and not for the one that has
 * not, and that a client which arrives late is told the same thing as one that
 * was there all along.
 *
 * The build under test carries no credential -- which is what this repo ships
 * -- so every one of these refuses locally, before anything is sent anywhere.
 */

let server: RunningServer;
let stateDir: string;

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "saarathi-signin-"));
  server = await startServer({
    stateFile: join(stateDir, "state.json"),
    env: { OVERLAYS_DIST: join(tmpdir(), "saarathi-no-such-dist") },
  });
});

afterAll(async () => {
  await server?.stop({ keepState: true });
  rmSync(stateDir, { recursive: true, force: true });
});

const signIn = async (): Promise<ChatSignInView> => {
  const snapshot = (await server.get("/api/state")) as Snapshot;
  return snapshot.core.chat.youtube!.signIn!;
};

describe("the sign-in over a socket", () => {
  it("rides in the slice a client is handed on connect", async () => {
    const client = await server.connect();
    try {
      const chat = client.snapshots[0]!.core.chat;
      expect(chat.youtube!.signIn).toMatchObject({ granted: false, clientId: "" });
      // Mock chat has no sign-in, so it has no section rather than an empty
      // one saying so -- the same rule that keeps it off her card entirely.
      expect(chat.mock).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  it("says where a credential comes from, and how long a sign-in lasts", async () => {
    // Both are facts about Google, so both come from the adapter. The second
    // is the one that surprises her a week later: a project in Testing expires
    // the sign-in after seven days.
    const view = await signIn();
    expect(view.clientHint).toContain("Google Cloud console");
    expect(view.clientHint).toContain("seven days");
    // A build carrying nothing asks her for one, rather than being broken.
    expect(view.builtIn).toBe(false);
  });

  it("routes all four actions to the adapter, over HTTP and over the socket", async () => {
    // A deck button, her control page and a hotkey all arrive through one of
    // these two doors. An id that never reached the chat router would come
    // back "no such action", which is a silence on her card.
    const client = await server.connect();
    try {
      for (const args of [["youtube"], ["mock"]]) {
        for (const action of [
          CORE_ACTIONS.chatSignIn,
          CORE_ACTIONS.chatSignOut,
          CORE_ACTIONS.chatClient,
          CORE_ACTIONS.chatForgetClient,
        ]) {
          const overHttp = await server.invoke({ action, args });
          const overSocket = await client.invoke({ action, args });
          // Whatever the answer is, both doors give the same one, and neither
          // says the action does not exist.
          expect(overSocket).toEqual(overHttp);
          if (!overHttp.ok) expect(overHttp.reason).not.toContain("No such action");
        }
      }
    } finally {
      await client.close();
    }
  });

  it("asks her for a credential rather than failing a call that could not work", async () => {
    // This is what a build carrying nothing does, which is what this repo
    // ships: dev, CI, and every build where the secret was never filled in.
    const result = await server.invoke({ action: CORE_ACTIONS.chatSignIn, args: ["youtube"] });
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("Add a Google client ID and secret first"),
    });
  });

  it("names the box she pasted the API key into, before writing anything", async () => {
    // The two live one card apart and both look like a long opaque string.
    // Google's own answer would be "invalid client", which names neither.
    const result = await server.invoke({
      action: CORE_ACTIONS.chatClient,
      args: ["youtube", "AIzaSyLooksLikeAnApiKey", "GOCSPX-secret"],
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toContain("YouTube API key");
    // Refused before anything was written, so the credential she had is intact.
    expect((await signIn()).clientId).toBe("");
  });

  it("echoes her client id back, and never the secret, to every client", async () => {
    // The id is public -- Google prints it on the consent screen -- and
    // reading it back is how she checks which of the two boxes she pasted
    // where. Done last, because it is the one that writes.
    const saved = await server.invoke({
      action: CORE_ACTIONS.chatClient,
      args: ["youtube", "hers.apps.googleusercontent.com", "GOCSPX-never-travels"],
    });
    expect(saved).toEqual({ ok: true });

    // A client that arrives after the fact, which is her phone waking up.
    const late = await server.connect();
    try {
      const view = late.snapshots[0]!.core.chat.youtube!.signIn!;
      expect(view.clientId).toBe("hers.apps.googleusercontent.com");
      expect(view.hasClientSecret).toBe(true);
      expect(JSON.stringify(late.snapshots[0])).not.toContain("GOCSPX-never-travels");
    } finally {
      await late.close();
    }

    // And the way back out.
    expect(await server.invoke({ action: CORE_ACTIONS.chatForgetClient, args: ["youtube"] })).toEqual({
      ok: true,
    });
    expect((await signIn()).clientId).toBe("");
  });
});
