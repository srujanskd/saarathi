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
    mime: "audio/wav",
    durationMs: 999_000,
    volume: 0.8,
    data: wav(2_000),
  };
}

function wav(durationMs: number): Buffer<ArrayBuffer> {
  const sampleRate = 8_000;
  const samples = Math.round(sampleRate * durationMs / 1_000);
  const data = Buffer.alloc(samples);
  const out = Buffer.alloc(44 + data.length);
  out.write("RIFF", 0);
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVEfmt ", 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write("data", 36);
  out.writeUInt32LE(data.length, 40);
  data.copy(out, 44);
  return out;
}

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

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

  it("reads the media type and duration from the bytes", async () => {
    const files = fakeFiles();
    const media = createMedia({ files, id: () => "item", assetKey: () => "key" });
    const h = await harness({ modules: [media.module] });
    const added = media.add(upload());
    expect(added).toMatchObject({
      ok: true,
      value: { mime: "audio/wav", durationMs: 2_000 },
    });
    expect(media.add({ ...upload(), mime: "audio/mpeg", data: Buffer.from("not media") }))
      .toMatchObject({ ok: false });
    expect(media.add({ ...upload("Badge"), mime: "image/png", data: PNG })).toMatchObject({
      ok: true,
      value: { mime: "image/png", durationMs: 5_000 },
    });
    expect(media.add({ ...upload(), mime: "image/png", data: PNG.subarray(0, 20) }))
      .toMatchObject({ ok: false });
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
    expect(stateOf(h.kernel.snapshot())).toMatchObject({ items: [], active: null });
    expect(files.saved.size).toBe(0);
    await h.stop();
  });

  it("rejects an unsupported or oversized upload before writing a file", async () => {
    const files = fakeFiles();
    const media = createMedia({ files });
    const h = await harness({ modules: [media.module] });
    expect(media.add({ ...upload(), mime: "text/plain" })).toMatchObject({ ok: false });
    expect(media.add({ ...upload(), data: wav(31_000) })).toMatchObject({ ok: false });
    expect(files.saved.size).toBe(0);
    await h.stop();
  });

  it("clears playback when the module is disabled", async () => {
    vi.useFakeTimers();
    const files = fakeFiles();
    const media = createMedia({ files, id: () => "item", assetKey: () => "key" });
    const h = await harness({ modules: [media.module] });
    const added = media.add(upload());
    if (!added.ok) throw new Error(added.reason);
    await h.kernel.invoke(`${MEDIA_ID}.play`, { args: [added.value.id] });

    await h.kernel.invoke("core.disable", { args: [MEDIA_ID] });
    await h.kernel.invoke("core.enable", { args: [MEDIA_ID] });
    expect(stateOf(h.kernel.snapshot()).active).toBeNull();
    await h.stop();
  });
});

describe("paid-message speech", () => {
  it("reads mock paid messages in order through media.play, without adding library clips", async () => {
    vi.useFakeTimers();
    const files = fakeFiles();
    const voice = vi.fn(async () => wav(2_000));
    const media = createMedia({ files, voice });
    const h = await harness({ modules: [media.module] });
    try {
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Keep going!" });
      h.chat({ type: "superchat", author: "Bo", amount: "$10.00", text: "One more rep!" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice.mock.calls).toMatchObject([["Ana sent $5.00. Keep going!", expect.any(AbortSignal)]]);
      const playing = stateOf(h.kernel.snapshot());
      expect(playing.items).toEqual([]);
      expect(playing.active?.itemId).toBe(playing.speech?.id);
      expect(playing.speech?.durationMs).toBe(2_000);
      expect(media.asset(playing.speech!.id, "wrong-key")).toBeNull();
      expect(media.asset(playing.speech!.id, playing.speech!.assetKey)).not.toBeNull();
      expect(h.store.read(MEDIA_ID)).not.toHaveProperty("speech");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(voice).toHaveBeenCalledTimes(2);
      expect(voice).toHaveBeenNthCalledWith(2, "Bo sent $10.00. One more rep!", expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      expect(stateOf(h.kernel.snapshot()).speech).toBeNull();
      expect(files.saved.size).toBe(0);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("ignores ordinary chat, persists mute across restarts, and can turn back on", async () => {
    const store = new MemoryStore();
    const voice = vi.fn(async () => wav(2_000));
    const first = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    first.chat("Hello");
    await first.kernel.invoke("media.tts", { args: ["off"] });
    first.chat({ type: "superchat", text: "Silent" });
    expect(voice).not.toHaveBeenCalled();
    await first.stop();
    const second = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    try {
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ ttsEnabled: false, active: null, speech: null });
      expect((await second.kernel.invoke("media.testVoice")).ok).toBe(false);
      await second.kernel.invoke("media.tts", { args: ["on"] });
      await second.kernel.invoke("media.testVoice");
      await vi.waitFor(() => expect(stateOf(second.kernel.snapshot()).active).not.toBeNull());
    } finally { await second.stop(); }
  });

  it.each(["media.stop", "media.tts", "core.disable"])("%s cancels pending synthesis and never plays a late result", async (action) => {
    let finish!: (data: Buffer) => void;
    let signal: AbortSignal | undefined;
    const files = fakeFiles();
    const media = createMedia({ files, voice: (_text, abort) => {
      signal = abort;
      return new Promise<Buffer>((resolve) => { finish = resolve; });
    } });
    const h = await harness({ modules: [media.module] });
    try {
      h.chat({ type: "superchat", text: "Read me" });
      h.chat({ type: "superchat", text: "And me" });
      await h.kernel.invoke(action, { args: action === "media.tts" ? ["off"] : action === "core.disable" ? [MEDIA_ID] : [] });
      expect(signal?.aborted).toBe(true);
      finish(wav(2_000));
      await Promise.resolve();
      expect(stateOf(h.kernel.snapshot())).toMatchObject({ active: null, speech: null });
      expect(files.saved.size).toBe(0);
    } finally { await h.stop(); }
  });

  it("stops active speech and drops the rest of the queue", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const files = fakeFiles();
    const h = await harness({ modules: [createMedia({ files, voice }).module] });
    try {
      h.chat({ type: "superchat", text: "First" });
      h.chat({ type: "superchat", text: "Second" });
      await vi.advanceTimersByTimeAsync(0);
      await h.kernel.invoke("media.stop");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(voice).toHaveBeenCalledTimes(1);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      expect(files.saved.size).toBe(0);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("reports failed synthesis and lets her retry without exposing the error", async () => {
    const voice = vi.fn().mockRejectedValueOnce(new Error("private provider details")).mockResolvedValue(wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      h.chat({ type: "superchat", text: "Hello" });
      await vi.waitFor(() => expect(stateOf(h.kernel.snapshot()).ttsStatus).toContain("Could not read"));
      expect(JSON.stringify(h.kernel.snapshot())).not.toContain("private provider details");
      await h.kernel.invoke("media.testVoice");
      await vi.waitFor(() => expect(stateOf(h.kernel.snapshot()).active).not.toBeNull());
    } finally { await h.stop(); }
  });

  it("bounds the queue during a burst of paid messages", async () => {
    let finish!: (data: Buffer) => void;
    const voice = vi.fn(() => new Promise<Buffer>((resolve) => { finish = resolve; }));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      for (let i = 0; i < 30; i++) h.chat({ type: "superchat", text: `Message ${i}` });
      expect(voice).toHaveBeenCalledTimes(1);
      expect(stateOf(h.kernel.snapshot()).ttsStatus).toContain("queue is full");
      await h.kernel.invoke("media.stop");
      finish(wav(2_000));
      await Promise.resolve();
    } finally { await h.stop(); }
  });
});

describe("choosing Microsoft speech", () => {
  const key = "abcdef0123456789abcdef0123456789";
  it("reads mock paid Kannada messages with Gagan and keeps the credential out of every publication", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const local = vi.fn(async () => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice: local, microsoftVoice: voice }).module] });
    try {
      await h.kernel.invoke("media.speechSettings", { args: ["microsoft", "centralindia", key] });
      h.chat({ type: "superchat", author: "Ana", amount: "₹100", text: "ನಮಸ್ಕಾರ" });
      await vi.advanceTimersByTimeAsync(100);
      expect(voice).toHaveBeenCalledWith("Ana ಅವರಿಂದ ₹100. ನಮಸ್ಕಾರ", expect.any(AbortSignal), { key, region: "centralindia" });
      expect(local).not.toHaveBeenCalled();
      expect(stateOf(h.kernel.snapshot())).toMatchObject({ speechProvider: "microsoft", hasSpeechKey: true });
      expect(stateOf(h.kernel.snapshot()).active).not.toBeNull();
      expect(JSON.stringify([h.kernel.snapshot(), h.seen.patches, h.seen.effects, h.log.text()])).not.toContain(key);
      expect(h.store.read(MEDIA_ID)).toMatchObject({ speechKey: key });
      await h.kernel.invoke("media.speechSettings", { args: ["microsoft", "eastus", ""] });
      expect(h.store.read(MEDIA_ID)).toMatchObject({ speechKey: key, speechRegion: "eastus" });
      await h.kernel.invoke("media.forgetSpeechKey");
      expect(h.store.read(MEDIA_ID)).toMatchObject({ speechKey: "" });
      expect((await h.kernel.invoke("media.testVoice")).ok).toBe(false);
      await h.kernel.invoke("media.speechSettings", { args: ["system", "", ""] });
      await h.kernel.invoke("media.testVoice");
      await vi.advanceTimersByTimeAsync(0);
      expect(local).toHaveBeenCalledTimes(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("cancels an old voice when settings change and restores the selected provider after restart", async () => {
    const store = new MemoryStore();
    let finish!: (data: Buffer) => void;
    let signal: AbortSignal | undefined;
    const voice = vi.fn((_text: string, abort: AbortSignal) => {
      signal = abort;
      return new Promise<Buffer>((resolve) => { finish = resolve; });
    });
    const files = fakeFiles();
    const first = await harness({ modules: [createMedia({ files, microsoftVoice: voice }).module], store });
    await first.kernel.invoke("media.speechSettings", { args: ["microsoft", "centralindia", key] });
    first.chat({ type: "superchat", text: "ನಮಸ್ಕಾರ" });
    await first.kernel.invoke("media.speechSettings", { args: ["microsoft", "eastus", key] });
    expect(signal!.aborted).toBe(true);
    finish(wav(2_000));
    await Promise.resolve();
    expect(files.saved.size).toBe(0);
    await first.stop();
    const second = await harness({ modules: [createMedia({ files, microsoftVoice: voice }).module], store });
    try {
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ speechProvider: "microsoft", speechRegion: "eastus", hasSpeechKey: true, active: null, speech: null });
      expect(JSON.stringify(second.kernel.snapshot())).not.toContain(key);
    } finally { await second.stop(); }
  });
});
