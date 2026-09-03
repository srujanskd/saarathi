import { beforeEach, describe, expect, it, vi } from "vitest";
import { MEDIA_ID, type MediaState } from "@saarathi/shared";
import type { MediaFiles } from "../../src/modules/media/files.js";
import { createMedia } from "../../src/modules/media/index.js";
import { MemoryStore } from "../../src/core/store.js";
import { harness } from "../helpers/kernel.js";

function fakeFiles(): MediaFiles & { saved: Set<string> } {
  const saved = new Set<string>();
  return {
    saved,
    put(id, mime) {
      saved.add(`${id}:${mime}`);
    },
    remove(item) {
      saved.delete(`${item.id}:${item.mime}`);
    },
    exists(item) {
      return saved.has(`${item.id}:${item.mime}`);
    },
    path(item) {
      return `/media/${item.id}`;
    },
  };
}

function upload(label = "Air horn") {
  return {
    label,
    mime: "audio/mpeg",
    durationMs: 2_000,
    volume: 0.8,
    data: Buffer.from("clip"),
  };
}

function stateOf(snapshot: { modules: Record<string, unknown> }): MediaState {
  return snapshot.modules[MEDIA_ID] as MediaState;
}

describe("media", () => {
  beforeEach(() => vi.useRealTimers());

  it("adds a durable clip and plays it through the same named action the deck uses", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const files = fakeFiles();
    let sequence = 0;
    const media = createMedia({
      files,
      now: Date.now,
      id: () => `id-${++sequence}`,
      assetKey: () => "asset-key",
    });
    const h = await harness({ modules: [media.module] });
    const added = media.add(upload());
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error(added.reason);

    await expect(h.kernel.invoke(`${MEDIA_ID}.play`, { args: [added.value.id] })).resolves.toEqual({ ok: true });
    expect(stateOf(h.kernel.snapshot()).active).toEqual({
      id: "id-2",
      itemId: "id-1",
      startedAt: 10_000,
      endsAt: 12_000,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(stateOf(h.kernel.snapshot()).active).toBeNull();
    await h.stop();
  });

  it("replaces the one playback lane and Stop all is the way out", async () => {
    const files = fakeFiles();
    let sequence = 0;
    const media = createMedia({ files, id: () => `id-${++sequence}`, assetKey: () => "key" });
    const h = await harness({ modules: [media.module] });
    const first = media.add(upload("First"));
    const second = media.add(upload("Second"));
    if (!first.ok || !second.ok) throw new Error("fixture failed");

    await h.kernel.invoke(`${MEDIA_ID}.play`, { args: [first.value.id] });
    await h.kernel.invoke(`${MEDIA_ID}.play`, { args: [second.value.id] });
    expect(stateOf(h.kernel.snapshot()).active?.itemId).toBe(second.value.id);
    await expect(h.kernel.invoke(`${MEDIA_ID}.stop`)).resolves.toEqual({ ok: true });
    expect(stateOf(h.kernel.snapshot()).active).toBeNull();
    await h.stop();
  });

  it("keeps the library across a restart and drops playback", async () => {
    const store = new MemoryStore();
    const files = fakeFiles();
    let sequence = 0;
    const firstMedia = createMedia({ files, id: () => `id-${++sequence}`, assetKey: () => "key" });
    const first = await harness({ modules: [firstMedia.module], store });
    const added = firstMedia.add(upload());
    if (!added.ok) throw new Error(added.reason);
    await first.kernel.invoke(`${MEDIA_ID}.play`, { args: [added.value.id] });
    await first.stop();

    const secondMedia = createMedia({ files });
    const second = await harness({ modules: [secondMedia.module], store });
    expect(stateOf(second.kernel.snapshot()).items.map((item) => item.label)).toEqual(["Air horn"]);
    expect(stateOf(second.kernel.snapshot()).active).toBeNull();
    await second.stop();
  });

  it("removes a clip, its file and an active cue together", async () => {
    const files = fakeFiles();
    const media = createMedia({ files, id: () => "item", assetKey: () => "key" });
    const h = await harness({ modules: [media.module] });
    const added = media.add(upload());
    if (!added.ok) throw new Error(added.reason);
    await h.kernel.invoke(`${MEDIA_ID}.play`, { args: [added.value.id] });

    expect(media.remove(added.value.id)).toEqual({ ok: true, value: undefined });
    expect(stateOf(h.kernel.snapshot())).toEqual({ items: [], active: null });
    expect(files.saved.size).toBe(0);
    await h.stop();
  });

  it("rejects an unsupported or oversized upload before writing a file", async () => {
    const files = fakeFiles();
    const media = createMedia({ files });
    const h = await harness({ modules: [media.module] });
    expect(media.add({ ...upload(), mime: "text/plain" })).toMatchObject({ ok: false });
    expect(media.add({ ...upload(), durationMs: 31_000 })).toMatchObject({ ok: false });
    expect(files.saved.size).toBe(0);
    await h.stop();
  });
});
