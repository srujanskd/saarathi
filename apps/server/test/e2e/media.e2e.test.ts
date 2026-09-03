import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { MEDIA_ID, type MediaItem, type MediaState, type Snapshot } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer();
});

afterAll(async () => {
  await server?.stop();
});

async function upload(label: string, target = server, durationMs = 2_000): Promise<MediaItem> {
  const query = new URLSearchParams({ label, durationMs: String(durationMs), volume: "0.8" });
  const response = await target.raw(`/api/media?${query}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${target.controlToken}`,
      "content-type": "audio/mpeg",
    },
    body: Buffer.from("media-bytes"),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { item: MediaItem }).item;
}

describe("the media pack", () => {
  it("refuses an upload from an unpaired device", async () => {
    const response = await server.raw("/api/media?label=x&durationMs=2000&volume=1", {
      method: "POST",
      headers: { "content-type": "audio/mpeg" },
      body: Buffer.from("no"),
    });
    expect(response.status).toBe(401);
  });

  it("uploads, serves ranges, plays, reconnects mid-cue and removes", async () => {
    const item = await upload("Air horn");
    const whole = await server.raw(`/api/media/${item.id}/${item.assetKey}`);
    expect(await whole.text()).toBe("media-bytes");

    const range = await server.raw(`/api/media/${item.id}/${item.assetKey}`, {
      headers: { range: "bytes=6-10" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("bytes");

    const control = await server.connect({ surface: "control", modules: [MEDIA_ID] });
    await expect(control.invoke({ action: `${MEDIA_ID}.play`, args: [item.id] })).resolves.toEqual({ ok: true });

    const late = await server.connect({ surface: "overlay", modules: [MEDIA_ID] }, "read");
    const state = late.snapshots.at(-1)!.modules[MEDIA_ID] as MediaState;
    expect(state.active?.itemId).toBe(item.id);
    expect(state.active!.endsAt).toBeGreaterThan(state.active!.startedAt);

    const removed = await server.raw(`/api/media/${item.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${server.controlToken}` },
    });
    expect(removed.status).toBe(200);
    const snapshot = (await server.get("/api/state")) as Snapshot;
    expect((snapshot.modules[MEDIA_ID] as MediaState).items).toEqual([]);
    expect((await server.raw(`/api/media/${item.id}/${item.assetKey}`)).status).toBe(404);
    await control.close();
    await late.close();
  });

  it("keeps the library and its file across a real restart, but stops playback", async () => {
    const first = await startServer();
    const directory = first.stateDir;
    if (!directory) throw new Error("test server did not create a state directory");
    let firstStopped = false;
    let second: RunningServer | null = null;
    try {
      const item = await upload("Restart clip", first, 20_000);
      const control = await first.connect({ surface: "control", modules: [MEDIA_ID] });
      await control.invoke({ action: `${MEDIA_ID}.play`, args: [item.id] });
      const before = (await first.get("/api/state")) as Snapshot;
      expect((before.modules[MEDIA_ID] as MediaState).active?.itemId).toBe(item.id);
      await control.close();
      await first.stop({ keepState: true });
      firstStopped = true;

      second = await startServer({ stateFile: first.stateFile });
      const snapshot = (await second.get("/api/state")) as Snapshot;
      const state = snapshot.modules[MEDIA_ID] as MediaState;
      expect(state.items.map((saved) => saved.label)).toEqual(["Restart clip"]);
      expect(state.active).toBeNull();
      expect(await (await second.raw(`/api/media/${item.id}/${item.assetKey}`)).text()).toBe("media-bytes");
    } finally {
      if (!firstStopped) await first.stop({ keepState: true });
      await second?.stop();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
