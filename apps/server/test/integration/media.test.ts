import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAID_QUEUE, MEDIA_ID, PAID_ALERT_MS, PAID_ALERT_TIER_MS, PAID_TIERS, type MediaState } from "@saarathi/shared";
import type { MediaFiles } from "../../src/modules/media/files.js";
import { createMedia } from "../../src/modules/media/index.js";
import { PickerError, type VoicePicker } from "../../src/modules/media/voice-picker.js";
import type { SpeechStyle } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import { harness } from "../helpers/kernel.js";
import { mockAuthorId } from "../../src/chat/mock.js";

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

function persistedPaid(store: MemoryStore): string[] {
  return ((store.read(MEDIA_ID) as MediaState | undefined)?.paid ?? []).map((message) => message.name);
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
      expect(voice.mock.calls).toMatchObject([["Ana sent $5.00. Keep going!", expect.any(AbortSignal), undefined]]);
      const playing = stateOf(h.kernel.snapshot());
      expect(playing.items).toEqual([]);
      expect(playing.active?.itemId).toBe(playing.speech?.id);
      expect(playing.active?.paidId).toBe(playing.paid[0]?.id);
      expect(playing.speech?.durationMs).toBe(2_000);
      // Two seconds of voice, but on screen long enough to read.
      expect(playing.active!.endsAt - playing.active!.startedAt).toBe(PAID_ALERT_MS);
      expect(media.asset(playing.speech!.id, "wrong-key")).toBeNull();
      expect(media.asset(playing.speech!.id, playing.speech!.assetKey)).not.toBeNull();
      expect(h.store.read(MEDIA_ID)).not.toHaveProperty("speech");
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenCalledTimes(2);
      expect(voice).toHaveBeenNthCalledWith(2, "Bo sent $10.00. One more rep!", expect.any(AbortSignal), undefined);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      expect(stateOf(h.kernel.snapshot()).speech).toBeNull();
      expect(files.saved.size).toBe(0);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("ignores ordinary chat, persists mute across restarts, and can turn back on", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const voice = vi.fn(async () => wav(2_000));
    const first = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    first.chat("Hello");
    await first.kernel.invoke("media.tts", { args: ["off"] });
    expect(stateOf(first.kernel.snapshot()).active).toBeNull();
    await first.stop();
    const second = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    try {
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ ttsEnabled: false, active: null, speech: null });
      expect((await second.kernel.invoke("media.testVoice")).ok).toBe(false);
      await second.kernel.invoke("media.tts", { args: ["on"] });
      await second.kernel.invoke("media.testVoice");
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(second.kernel.snapshot()).active).not.toBeNull();
      expect(voice).toHaveBeenCalledTimes(1);
    } finally { await second.stop(); vi.useRealTimers(); }
  });

  it("shows a paid message without a voice when speech is off, and drains on its own", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const voice = vi.fn(async () => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      await h.kernel.invoke("media.tts", { args: ["off"] });
      h.chat({ type: "superchat", author: "Ana", amount: "₹100.00", text: "Quiet one" });
      h.chat({ type: "superchat", author: "Bo", text: "Second" });
      const shown = stateOf(h.kernel.snapshot());
      expect(shown.active).toMatchObject({ itemId: null, paidId: shown.paid[0]!.id, startedAt: 10_000, endsAt: 10_000 + PAID_ALERT_MS });
      expect(shown.paid[0]).toMatchObject({ name: "Ana", amount: "₹100.00", text: "Quiet one" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active?.paidId).toBe(stateOf(h.kernel.snapshot()).paid[0]!.id);
      expect(stateOf(h.kernel.snapshot()).paid.map((message) => message.name)).toEqual(["Bo"]);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot())).toMatchObject({ active: null, paid: [] });
      expect(voice).not.toHaveBeenCalled();
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("still shows paid messages on a server with no voice at all", async () => {
    const h = await harness({ modules: [createMedia({ files: fakeFiles() }).module] });
    try {
      h.chat({ type: "superchat", author: "Ana", text: "Linux box" });
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: null });
    } finally { await h.stop(); }
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
      const after = stateOf(h.kernel.snapshot());
      expect(after.speech).toBeNull();
      // Speech off carries on silently; the other two leave the lane empty.
      expect(after.active?.itemId ?? null).toBeNull();
      expect(Boolean(after.active)).toBe(action === "media.tts");
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

  it("pauses a message for a clip she pressed and reads it again in full afterwards", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const files = fakeFiles();
    const media = createMedia({ files, voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      h.chat({ type: "superchat", author: "Ana", text: "First" });
      h.chat({ type: "superchat", author: "Bo", text: "Second" });
      await vi.advanceTimersByTimeAsync(1_000);
      await h.kernel.invoke(`${MEDIA_ID}.play`, { args: [horn.value.id] });
      expect(stateOf(h.kernel.snapshot()).active?.itemId).toBe(horn.value.id);
      expect(stateOf(h.kernel.snapshot()).paid.map((message) => message.name)).toEqual(["Ana", "Bo"]);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice.mock.calls.map(([text]) => text)).toEqual([
        "Ana sent $5.00. First", "Ana sent $5.00. First", "Bo sent $5.00. Second",
      ]);
      expect(stateOf(h.kernel.snapshot())).toMatchObject({ paid: [], active: null, speech: null });
      expect([...files.saved]).toEqual([`${horn.value.id}:audio/wav`]);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("reads what was waiting after a restart, starting with the one cut off", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const voice = vi.fn(async () => wav(2_000));
    const first = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    first.chat({ type: "superchat", author: "Ana", text: "First" });
    first.chat({ type: "superchat", author: "Bo", text: "Second" });
    await vi.advanceTimersByTimeAsync(1_000);
    await first.stop();
    expect(persistedPaid(store)).toEqual(["Ana", "Bo"]);

    voice.mockClear();
    const second = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenCalledWith("Ana sent $5.00. First", expect.any(AbortSignal), undefined);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenLastCalledWith("Bo sent $5.00. Second", expect.any(AbortSignal), undefined);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(persistedPaid(store)).toEqual([]);
    } finally { await second.stop(); vi.useRealTimers(); }
  });

  it("shows a message silently when its voice fails, then reads the next one", async () => {
    vi.useFakeTimers();
    const voice = vi.fn().mockRejectedValueOnce(new Error("blip")).mockResolvedValue(wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      h.chat({ type: "superchat", author: "Ana", text: "First" });
      h.chat({ type: "superchat", author: "Bo", text: "Second" });
      await vi.advanceTimersByTimeAsync(0);
      const failed = stateOf(h.kernel.snapshot());
      expect(failed.active).toMatchObject({ itemId: null, paidId: failed.paid[0]!.id });
      expect(failed.paid[0]!.name).toBe("Ana");
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenLastCalledWith("Bo sent $5.00. Second", expect.any(AbortSignal), undefined);
      expect(stateOf(h.kernel.snapshot()).paid.map((message) => message.name)).toEqual(["Bo"]);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("reports failed synthesis and lets her retry without exposing the error", async () => {
    vi.useFakeTimers();
    const voice = vi.fn().mockRejectedValueOnce(new Error("private provider details")).mockResolvedValue(wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      h.chat({ type: "superchat", text: "Hello" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(h.kernel.snapshot()).ttsStatus).toContain("Could not read");
      expect(JSON.stringify(h.kernel.snapshot())).not.toContain("private provider details");
      await h.kernel.invoke("media.testVoice");
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenCalledTimes(2);
      expect(stateOf(h.kernel.snapshot()).speech).not.toBeNull();
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("bounds the queue during a burst of paid messages", async () => {
    let finish!: (data: Buffer) => void;
    const voice = vi.fn(() => new Promise<Buffer>((resolve) => { finish = resolve; }));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      for (let i = 0; i < MAX_PAID_QUEUE + 5; i++) h.chat({ type: "superchat", text: `Message ${i}` });
      expect(voice).toHaveBeenCalledTimes(1);
      expect(stateOf(h.kernel.snapshot()).paid).toHaveLength(MAX_PAID_QUEUE);
      expect(stateOf(h.kernel.snapshot()).ttsStatus).toContain("queue is full");
      await h.kernel.invoke("media.stop");
      finish(wav(2_000));
      await Promise.resolve();
    } finally { await h.stop(); }
  });
});

describe("how a paid alert looks", () => {
  it("gives a bigger message from mock chat its size and more time on screen, and none to an unbanded one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = await harness({ modules: [createMedia({ files: fakeFiles() }).module] });
    try {
      h.chat({ type: "superchat", author: "Big", amount: "₹5,000.00", text: "Go!", tier: PAID_TIERS });
      h.chat({ type: "superchat", author: "Tip", text: "Thanks" });
      const big = stateOf(h.kernel.snapshot());
      expect(big.paid.map((message) => message.tier)).toEqual([PAID_TIERS, undefined]);
      expect(big.active).toMatchObject({ paidId: big.paid[0]!.id, endsAt: 10_000 + PAID_ALERT_MS + (PAID_TIERS - 1) * PAID_ALERT_TIER_MS });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active?.paidId).toBe(big.paid[0]!.id);
      await vi.advanceTimersByTimeAsync((PAID_TIERS - 1) * PAID_ALERT_TIER_MS);
      const after = stateOf(h.kernel.snapshot());
      expect(after.paid.map((message) => message.name)).toEqual(["Tip"]);
      expect(after.active!.endsAt - after.active!.startedAt).toBe(PAID_ALERT_MS);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("keeps her look and position across a restart and refuses one that does not exist", async () => {
    const store = new MemoryStore();
    const first = await harness({ modules: [createMedia({ files: fakeFiles() }).module], store });
    expect(stateOf(first.kernel.snapshot())).toMatchObject({ alertTheme: "card", alertPosition: "top" });
    expect(await first.kernel.invoke("media.alertTheme", { args: ["bold"] })).toEqual({ ok: true });
    expect(await first.kernel.invoke("media.alertPosition", { args: ["bottom-left"] })).toEqual({ ok: true });
    expect(await first.kernel.invoke("media.alertTheme", { args: ["neon"] })).toMatchObject({ ok: false });
    expect(await first.kernel.invoke("media.alertPosition", { args: ["toString"] })).toMatchObject({ ok: false });
    await first.stop();

    const second = await harness({ modules: [createMedia({ files: fakeFiles() }).module], store });
    try {
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ alertTheme: "bold", alertPosition: "bottom-left" });
    } finally { await second.stop(); }
  });

  it("previews each size silently without queueing anything, never over a real alert, and Stop clears it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const voice = vi.fn(async () => wav(2_000));
    const store = new MemoryStore();
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module], store });
    try {
      expect(await h.kernel.invoke("media.previewAlert", { args: ["0"] })).toMatchObject({ ok: false });
      expect(await h.kernel.invoke("media.previewAlert", { args: ["6"] })).toEqual({ ok: true });
      const shown = stateOf(h.kernel.snapshot());
      expect(shown.active).toMatchObject({ itemId: null, sample: { tier: 6, name: "Preview" }, endsAt: 10_000 + PAID_ALERT_MS + 5 * PAID_ALERT_TIER_MS });
      expect(shown.active).not.toHaveProperty("paidId");
      expect(shown.paid).toEqual([]);
      expect(persistedPaid(store)).toEqual([]);
      expect(await h.kernel.invoke("media.previewAlert", { args: ["2"] })).toMatchObject({ ok: false });

      // A real one waits for the preview rather than being pushed off.
      h.chat({ type: "superchat", author: "Ana", text: "Real" });
      expect(stateOf(h.kernel.snapshot()).active?.sample).toBeDefined();
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS + 5 * PAID_ALERT_TIER_MS);
      expect(voice).toHaveBeenCalledTimes(1);
      expect(voice).toHaveBeenCalledWith("Ana sent $5.00. Real", expect.any(AbortSignal), undefined);
      expect(await h.kernel.invoke("media.stop", { args: [] })).toEqual({ ok: true });

      expect(await h.kernel.invoke("media.previewAlert", { args: ["1"] })).toEqual({ ok: true });
      expect(await h.kernel.invoke("media.stop", { args: [] })).toEqual({ ok: true });
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("End preview hands the lane to whoever paid meanwhile, and Stop stays a full stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = await harness({ modules: [createMedia({ files: fakeFiles() }).module] });
    try {
      expect(await h.kernel.invoke("media.tts", { args: ["off"] })).toEqual({ ok: true });
      expect(await h.kernel.invoke("media.previewAlert", { args: [String(PAID_TIERS)] })).toEqual({ ok: true });
      h.chat({ type: "superchat", author: "Ana", amount: "₹500.00", text: "Real" });
      const sample = stateOf(h.kernel.snapshot()).active?.sample;
      expect(sample).toBeDefined();

      // A tap meant for some other preview ends nothing.
      expect(await h.kernel.invoke("media.endPreview", { args: ["preview-elsewhere"] })).toMatchObject({ ok: false });
      expect(await h.kernel.invoke("media.endPreview", { args: [sample!.id] })).toEqual({ ok: true });
      const after = stateOf(h.kernel.snapshot());
      expect(after.paid.map((message) => message.name)).toEqual(["Ana"]);
      expect(after.active).toMatchObject({ paidId: after.paid[0]!.id });
      expect(after.active).not.toHaveProperty("sample");
      expect(await h.kernel.invoke("media.endPreview", { args: [sample!.id] })).toMatchObject({ ok: false });

      // Stop is her panic button on the deck. Over a preview it stops the
      // preview and everything queued behind it, and puts nothing on stream.
      expect(await h.kernel.invoke("media.stop", { args: [] })).toEqual({ ok: true });
      expect(await h.kernel.invoke("media.previewAlert", { args: ["1"] })).toEqual({ ok: true });
      h.chat({ type: "superchat", author: "Bo", amount: "₹500.00", text: "Also real" });
      expect(await h.kernel.invoke("media.stop", { args: [] })).toEqual({ ok: true });
      expect(stateOf(h.kernel.snapshot())).toMatchObject({ active: null, paid: [] });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("drops a saved size this build has no look for", async () => {
    const store = new MemoryStore();
    store.write(MEDIA_ID, { paid: [{ id: "a", at: 1, name: "Ana", amount: "$5.00", text: "", tier: 99 },
      { id: "b", at: 2, name: "Bo", amount: "$5.00", text: "", tier: 3 }], alertTheme: "neon", alertPosition: 7 });
    const h = await harness({ modules: [createMedia({ files: fakeFiles() }).module], store });
    try {
      const state = stateOf(h.kernel.snapshot());
      expect(state.paid.map((message) => message.tier)).toEqual([undefined, 3]);
      expect(state).toMatchObject({ alertTheme: "card", alertPosition: "top" });
    } finally { await h.stop(); }
  });
});

describe("guarding paid messages", () => {
  it("never reads a link and thanks a scam by name only, through mock chat", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      h.chat({ type: "superchat", author: "Ana", text: "my plan is at fitplan.xyz/ana" });
      h.chat({ type: "superchat", author: "Bot", text: "you have won, claim your prize on telegram" });
      await vi.advanceTimersByTimeAsync(0);
      const first = stateOf(h.kernel.snapshot()).paid[0]!;
      expect(first.text).toBe("my plan is at (link)");
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).paid[0]).toMatchObject({ name: "Bot", text: "", cut: "Asks people to message an account off-platform" });
      expect(voice.mock.calls.map(([text]) => text)).toEqual(["Ana sent $5.00. my plan is at (link)", "Bot sent $5.00. Thank you!"]);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("with check first on, holds a message with words until she answers from the card or the deck", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      expect(await h.kernel.invoke(`${MEDIA_ID}.approve`)).toMatchObject({ ok: false, reason: "No paid message is waiting for you" });
      await h.kernel.invoke(`${MEDIA_ID}.checkFirst`, { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", text: "Read me?" });
      h.chat({ type: "superchat", author: "Bo", text: "Something rude" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      const waiting = stateOf(h.kernel.snapshot());
      expect(waiting.active).toBeNull();
      expect(waiting.ttsStatus).toContain("Ana's message is waiting");
      expect(voice).not.toHaveBeenCalled();

      // Her card names the message, so a stale tap cannot land on the next one.
      expect(await h.kernel.invoke(`${MEDIA_ID}.approve`, { args: [waiting.paid[1]!.id] }))
        .toMatchObject({ ok: false, reason: "That message has moved on" });
      expect(await h.kernel.invoke(`${MEDIA_ID}.approve`, { args: [waiting.paid[0]!.id] })).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();

      // A deck button sends no id and answers the one at the head.
      await h.kernel.invoke(`${MEDIA_ID}.thanksOnly`, { via: "deck" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(h.kernel.snapshot()).paid[0]).toMatchObject({ name: "Bo", text: "", cut: "You left it out" });
      expect(voice.mock.calls.map(([text]) => text)).toEqual(["Ana sent $5.00. Read me?", "Bo sent $5.00. Thank you!"]);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("does not hold a message with no words, and turning checking off lets the line go", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      await h.kernel.invoke(`${MEDIA_ID}.checkFirst`, { args: ["on"] });
      h.chat({ type: "superchat", author: "Bot", text: "dm me on telegram" });
      h.chat({ type: "superchat", author: "Ana", text: "Held" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Bot sent $5.00. Thank you!", expect.any(AbortSignal), undefined);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      await h.kernel.invoke(`${MEDIA_ID}.checkFirst`, { args: ["off"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Held", expect.any(AbortSignal), undefined);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("keeps checking on, and the message it is holding, across a restart", async () => {
    const store = new MemoryStore();
    const first = await harness({ modules: [createMedia({ files: fakeFiles() }).module], store });
    await first.kernel.invoke(`${MEDIA_ID}.checkFirst`, { args: ["on"] });
    first.chat({ type: "superchat", author: "Ana", text: "Still here?" });
    await first.stop();
    const second = await harness({ modules: [createMedia({ files: fakeFiles() }).module], store });
    try {
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ checkFirst: true, active: null, paid: [{ name: "Ana", text: "Still here?" }] });
      await second.kernel.invoke(`${MEDIA_ID}.approve`);
      expect(stateOf(second.kernel.snapshot()).active).toMatchObject({ itemId: null });
    } finally { await second.stop(); }
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
      expect(voice).toHaveBeenCalledWith("Ana ಅವರಿಂದ ₹100. ನಮಸ್ಕಾರ", expect.any(AbortSignal), { key, region: "centralindia" }, undefined);
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
      // Waits behind the message now on screen without a voice.
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(local).toHaveBeenCalledTimes(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("cancels an old voice when settings change, keeps the message, and restores the provider after restart", async () => {
    const store = new MemoryStore();
    let finish!: (data: Buffer) => void;
    const signals: AbortSignal[] = [];
    const voice = vi.fn((_text: string, abort: AbortSignal) => {
      signals.push(abort);
      return new Promise<Buffer>((resolve) => { finish = resolve; });
    });
    const files = fakeFiles();
    const first = await harness({ modules: [createMedia({ files, microsoftVoice: voice }).module], store });
    await first.kernel.invoke("media.speechSettings", { args: ["microsoft", "centralindia", key] });
    first.chat({ type: "superchat", text: "ನಮಸ್ಕಾರ" });
    const old = finish;
    await first.kernel.invoke("media.speechSettings", { args: ["microsoft", "eastus", key] });
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(stateOf(first.kernel.snapshot()).paid).toHaveLength(1);
    old(wav(2_000));
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

describe("Claude picking voices", () => {
  function fakePicker(answer: (text: string) => SpeechStyle | Promise<SpeechStyle> = () => ({ voice: "bright", mood: "excited" })) {
    const pick = vi.fn(async (input: { name: string; amount: string; text: string }, _signal: AbortSignal) => answer(input.text));
    const picker: VoicePicker & { pick: typeof pick } = { available: () => true, pick };
    return picker;
  }
  type Stored = { viewerVoices: [string, string][]; pickVoices: boolean };
  const stored = (store: { read(id: string): unknown }) => store.read(MEDIA_ID) as Stored;

  it("is off until she switches it on, and refuses to switch on where Claude Code is missing", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker();
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    const bare = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker: { ...picker, available: () => false } }).module] });
    try {
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).not.toHaveBeenCalled();
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Hi", expect.any(AbortSignal), undefined);
      expect(await bare.kernel.invoke("media.pickVoices", { args: ["on"] }))
        .toMatchObject({ ok: false, reason: expect.stringContaining("Claude Code is not set up") });
      expect(stateOf(bare.kernel.snapshot()).pickVoices).toBe(false);
    } finally { await h.stop(); await bare.stop(); vi.useRealTimers(); }
  });

  it("reads a mock paid message in the voice and mood Claude picked, and remembers the viewer's voice", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker((text) => text === "Calm down" ? { voice: "warm", mood: "calm" } : { voice: "bright", mood: "excited" });
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      expect((await h.kernel.invoke("media.pickVoices", { args: ["on"] })).ok).toBe(true);
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "LETS GO" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledWith({ name: "Ana", amount: "$5.00", text: "LETS GO" }, expect.any(AbortSignal));
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. LETS GO", expect.any(AbortSignal), { voice: "bright", mood: "excited" });
      expect(stateOf(h.kernel.snapshot()).paid[0]?.style).toEqual({ voice: "bright", mood: "excited" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);

      // The same viewer keeps their voice; only the mood follows the new message.
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Calm down" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Calm down", expect.any(AbortSignal), { voice: "bright", mood: "calm" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);

      // No words and a known voice: nothing to ask Claude about.
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledTimes(2);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Thank you!", expect.any(AbortSignal), { voice: "bright", mood: "neutral" });

      // Who has a voice stays on the server; her page sees a count.
      const published = stateOf(h.kernel.snapshot());
      expect(published).toMatchObject({ rememberedVoices: 1 });
      expect(published).not.toHaveProperty("viewerVoices");
      expect(JSON.stringify(h.seen.patches)).not.toContain("viewerVoices");
      expect(stored(h.store).viewerVoices).toHaveLength(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("reads in the default voice and says why when Claude does not answer", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker(() => { throw new PickerError("unanswered"); });
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Hi", expect.any(AbortSignal), undefined);
      const state = stateOf(h.kernel.snapshot());
      expect(state.pickerStatus).toContain("default voice was used");
      expect(state.paid[0]?.style).toBeUndefined();
      expect(state.rememberedVoices).toBe(0);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("keeps a chosen style, the switch and remembered voices across a restart, without asking again", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    // Still being read when the server stops.
    const slow = vi.fn((_text: string, _signal: AbortSignal, _style?: SpeechStyle) => new Promise<Buffer>(() => undefined));
    const picker = fakePicker(() => ({ voice: "buddy", mood: "heartfelt" }));
    const first = await harness({ modules: [createMedia({ files: fakeFiles(), voice: slow, picker }).module], store });
    await first.kernel.invoke("media.pickVoices", { args: ["on"] });
    first.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Thank you for this" });
    await vi.advanceTimersByTimeAsync(0);
    expect(slow).toHaveBeenCalledTimes(1);
    await first.stop();

    const voice = vi.fn(async () => wav(2_000));
    const second = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module], store });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledTimes(1);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Thank you for this", expect.any(AbortSignal), { voice: "buddy", mood: "heartfelt" });
      expect(stateOf(second.kernel.snapshot())).toMatchObject({ pickVoices: true, rememberedVoices: 1 });
      // No undo, so never a bare deck button or hotkey, and never without saying so.
      const media = second.kernel.coreState().modules.find((module) => module.id === MEDIA_ID);
      expect(media?.actions.map((action) => action.id)).not.toContain("media.forgetVoices");
      expect(await second.kernel.invoke("media.forgetVoices")).toMatchObject({ ok: false });
      expect(stored(store).viewerVoices).toHaveLength(1);
      expect(await second.kernel.invoke("media.forgetVoices", { args: ["all"] })).toMatchObject({ ok: true });
      expect(stateOf(second.kernel.snapshot()).rememberedVoices).toBe(0);
      expect(stored(store).viewerVoices).toEqual([]);
      expect(await second.kernel.invoke("media.forgetVoices", { args: ["all"] })).toMatchObject({ ok: false });
      await second.kernel.invoke("media.pickVoices", { args: ["off"] });
      expect(stored(store).pickVoices).toBe(false);
    } finally { await second.stop(); vi.useRealTimers(); }
  });

  it("Stop while Claude is choosing cancels the pick and reads nothing", async () => {
    const voice = vi.fn(async () => wav(2_000));
    const signals: AbortSignal[] = [];
    const picker: VoicePicker = {
      available: () => true,
      pick: (_input, signal) => { signals.push(signal); return new Promise(() => undefined); },
    };
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Hi" });
      await Promise.resolve();
      expect(stateOf(h.kernel.snapshot()).ttsStatus).toBe("Choosing a voice…");
      expect((await h.kernel.invoke("media.stop")).ok).toBe(true);
      expect(signals[0]?.aborted).toBe(true);
      expect(voice).not.toHaveBeenCalled();
      expect(stateOf(h.kernel.snapshot()).paid).toEqual([]);
    } finally { await h.stop(); }
  });

  it("chooses the next message's voice while the one before is playing", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker();
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "One" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenCalledTimes(1);
      // Ben arrives while Ana is on screen, and his voice is settled behind her.
      h.chat({ type: "superchat", author: "Ben", amount: "$5.00", text: "Two" });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenCalledTimes(1);
      expect(picker.pick).toHaveBeenCalledTimes(2);
      expect(stateOf(h.kernel.snapshot()).paid[1]?.style).toEqual({ voice: "bright", mood: "excited" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenLastCalledWith("Ben sent $5.00. Two", expect.any(AbortSignal), { voice: "bright", mood: "excited" });
      expect(picker.pick).toHaveBeenCalledTimes(2);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("does not send a message she has not checked yet to Claude", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker();
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      await h.kernel.invoke("media.checkFirst", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Words" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).not.toHaveBeenCalled();
      await h.kernel.invoke("media.approve");
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledTimes(1);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Words", expect.any(AbortSignal), { voice: "bright", mood: "excited" });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("stops asking for five minutes after Claude fails, and asks again when she switches it back on", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const picker = fakePicker(() => { throw new PickerError("unanswered"); });
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      for (const author of ["Ana", "Ben", "Cy"]) h.chat({ type: "superchat", author, amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledTimes(1);
      expect(stateOf(h.kernel.snapshot()).pickerStatus).toContain("again in five minutes");
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS * 3);
      expect(voice).toHaveBeenCalledTimes(3);
      expect(voice).toHaveBeenLastCalledWith("Cy sent $5.00. Hi", expect.any(AbortSignal), undefined);
      expect(picker.pick).toHaveBeenCalledTimes(1);

      await h.kernel.invoke("media.pickVoices", { args: ["off"] });
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Dee", amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      expect(picker.pick).toHaveBeenCalledTimes(2);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("switching it off lets a message waiting on Claude go in the default voice", async () => {
    const voice = vi.fn(async () => wav(2_000));
    const signals: AbortSignal[] = [];
    const picker: VoicePicker = {
      available: () => true,
      pick: (_input, signal) => { signals.push(signal); return new Promise(() => undefined); },
    };
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Hi" });
      await Promise.resolve();
      expect(voice).not.toHaveBeenCalled();
      await h.kernel.invoke("media.pickVoices", { args: ["off"] });
      expect(signals[0]?.aborted).toBe(true);
      await vi.waitFor(() => expect(voice).toHaveBeenCalledWith("Ana sent $5.00. Hi", expect.any(AbortSignal), undefined));
    } finally { await h.stop(); }
  });

  it("keeps who sent a message off every page, OBS included", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker: fakePicker() }).module] });
    try {
      await h.kernel.invoke("media.pickVoices", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      const author = mockAuthorId("Ana");
      expect(JSON.stringify(h.kernel.snapshot())).not.toContain(author);
      expect(JSON.stringify(h.seen.patches)).not.toContain(author);
      expect(stateOf(h.kernel.snapshot()).rememberedVoices).toBe(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("forgets whoever was heard least recently once the list is full, not whoever came first", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const others = Array.from({ length: 499 }, (_, index) => [`mock:viewer${index}`, "buddy"] as [string, string]);
    store.write(MEDIA_ID, { pickVoices: true, viewerVoices: [[mockAuthorId("Ana"), "warm"], ...others] });
    const voice = vi.fn(async () => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice, picker: fakePicker() }).module], store });
    try {
      // Ana came first and is back; then someone new arrives and the list is full.
      h.chat({ type: "superchat", author: "Ana", amount: "$5.00", text: "" });
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      h.chat({ type: "superchat", author: "Newcomer", amount: "$5.00", text: "Hi" });
      await vi.advanceTimersByTimeAsync(0);
      const kept = stored(store).viewerVoices.map(([viewer]) => viewer);
      expect(kept).toHaveLength(500);
      expect(kept).toContain(mockAuthorId("Ana"));
      expect(kept).not.toContain("mock:viewer0");
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("drops a saved voice or mood this build does not have instead of trusting it", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    store.write(MEDIA_ID, {
      ttsEnabled: false,
      paid: [{ id: "old", at: 1, name: "Ana", amount: "$5.00", text: "Hi", style: { voice: "toString", mood: "neutral" } }],
      viewerVoices: [["mock:Ana", "robot"], ["mock:Ben", "warm"]],
    });
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice: vi.fn(async () => wav(2_000)) }).module], store });
    try {
      const state = stateOf(h.kernel.snapshot());
      expect(state.paid[0]).not.toHaveProperty("style");
      expect(state.rememberedVoices).toBe(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("lets her hear each voice from Test voice, and refuses one that does not exist", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => wav(2_000));
    const h = await harness({ modules: [createMedia({ files: fakeFiles(), voice }).module] });
    try {
      expect((await h.kernel.invoke("media.testVoice", { args: ["warm"] })).ok).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Thank you for supporting the stream!", expect.any(AbortSignal), { voice: "warm", mood: "neutral" });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await h.kernel.invoke("media.testVoice", { args: ["robot"] })).toMatchObject({ ok: false });
      // Names every object inherits are not voices either.
      for (const inherited of ["toString", "constructor", "__proto__"]) {
        expect(await h.kernel.invoke("media.testVoice", { args: [inherited] })).toMatchObject({ ok: false });
      }
      await h.kernel.invoke("media.testVoice");
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Thank you for supporting the stream!", expect.any(AbortSignal), undefined);
    } finally { await h.stop(); vi.useRealTimers(); }
  });
});

describe("her alert levels and the clip each one plays first", () => {
  const levels = (list: { from: number; introId?: string }[]) => [JSON.stringify(list)];

  it("groups mock Super Chats into five levels, sized and timed by her level rather than the rung", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const h = await harness({ modules: [createMedia({ files: fakeFiles() }).module] });
    try {
      expect(await h.kernel.invoke("media.tts", { args: ["off"] })).toEqual({ ok: true });
      expect(await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1 }, { from: 3 }, { from: 4 }, { from: 5 }, { from: 6 }]) }))
        .toEqual({ ok: true });
      h.chat({ type: "superchat", author: "Red", amount: "₹5,000.00", text: "Top", tier: 7 });
      h.chat({ type: "superchat", author: "Magenta", amount: "₹2,000.00", text: "Same level", tier: 6 });
      h.chat({ type: "superchat", author: "Light blue", amount: "₹80.00", text: "Bottom", tier: 2 });
      const seen: { level?: number; size?: number; ms: number }[] = [];
      for (let shown = 0; shown < 3; shown++) {
        const cue = stateOf(h.kernel.snapshot()).active!;
        seen.push({ level: cue.level, size: cue.size, ms: cue.endsAt - cue.startedAt });
        await vi.advanceTimersByTimeAsync(cue.endsAt - cue.startedAt);
      }
      expect(seen).toEqual([
        { level: 5, size: 7, ms: PAID_ALERT_MS + 6 * PAID_ALERT_TIER_MS },
        { level: 5, size: 7, ms: PAID_ALERT_MS + 6 * PAID_ALERT_TIER_MS },
        { level: 1, size: 1, ms: PAID_ALERT_MS },
      ]);
      expect(await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 2 }]) }))
        .toMatchObject({ ok: false, reason: "The first level has to start at the smallest" });
      expect(await h.kernel.invoke("media.alertLevels", { args: ["not json"] })).toMatchObject({ ok: false });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("plays the level's clip, then the speech it made ready meanwhile, then the next message", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload("Air horn"));
      if (!horn.ok) throw new Error(horn.reason);
      expect(await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1 }, { from: 6, introId: horn.value.id }]) }))
        .toEqual({ ok: true });
      h.chat({ type: "superchat", author: "Ana", amount: "₹5,000.00", text: "Big", tier: 7 });
      h.chat({ type: "superchat", author: "Bo", amount: "₹100.00", text: "Small", tier: 2 });
      await vi.advanceTimersByTimeAsync(0);

      const intro = stateOf(h.kernel.snapshot());
      expect(intro.active).toMatchObject({ itemId: horn.value.id, introFor: intro.paid[0]!.id, level: 2, size: 7 });
      expect(intro.active).not.toHaveProperty("paidId");
      // Made before the intro, so it is ready the moment the intro ends.
      expect(voice.mock.calls.map(([text]) => text)).toEqual(["Ana sent ₹5,000.00. Big"]);
      expect(intro.ttsStatus).toBe("Playing the intro for Ana");

      await vi.advanceTimersByTimeAsync(2_000);
      const reading = stateOf(h.kernel.snapshot());
      expect(reading.active).toMatchObject({ itemId: reading.speech!.id, paidId: reading.paid[0]!.id, level: 2, size: 7 });
      expect(voice).toHaveBeenCalledTimes(1);

      // Level 1 has no clip: straight to its speech.
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS + 6 * PAID_ALERT_TIER_MS);
      const next = stateOf(h.kernel.snapshot());
      expect(next.paid.map((message) => message.name)).toEqual(["Bo"]);
      expect(next.active).toMatchObject({ itemId: next.speech!.id, paidId: next.paid[0]!.id, level: 1 });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("with speech off, or a voice that fails, still plays the clip and then shows the alert", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async () => { throw new Error("no voice"); });
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1, introId: horn.value.id }]) });
      h.chat({ type: "superchat", author: "Ana", text: "Failing voice" });
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: horn.value.id });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: null, paidId: stateOf(h.kernel.snapshot()).paid[0]!.id });
      // Shown silently; the voice that just failed is not asked again for the same message.
      expect(voice).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);

      await h.kernel.invoke("media.tts", { args: ["off"] });
      h.chat({ type: "superchat", author: "Bo", text: "Quiet" });
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: horn.value.id });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: null, paidId: stateOf(h.kernel.snapshot()).paid[0]!.id });
      expect(voice).toHaveBeenCalledTimes(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("holds the clip as well as the words until she lets a checked message through", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1, introId: horn.value.id }]) });
      await h.kernel.invoke("media.checkFirst", { args: ["on"] });
      h.chat({ type: "superchat", author: "Ana", text: "Check me" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      expect(await h.kernel.invoke("media.approve")).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: horn.value.id });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("Skip intro, from the card or the deck, goes straight to the message, and refuses when no intro is on", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      expect(await h.kernel.invoke("media.skipIntro")).toMatchObject({ ok: false, reason: "No intro is playing" });
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1, introId: horn.value.id }]) });
      h.chat({ type: "superchat", author: "Ana", text: "Skip to me" });
      await vi.advanceTimersByTimeAsync(500);
      expect(await h.kernel.invoke("media.skipIntro")).toEqual({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      const state = stateOf(h.kernel.snapshot());
      expect(state.active).toMatchObject({ itemId: state.speech!.id, paidId: state.paid[0]!.id });
      expect(voice).toHaveBeenCalledTimes(1);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("a clip she presses over the intro does not cost the message its turn, and its intro plays again after", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload("Air horn"));
      const drum = media.add(upload("Drum"));
      if (!horn.ok || !drum.ok) throw new Error("upload");
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1, introId: horn.value.id }]) });
      h.chat({ type: "superchat", author: "Ana", text: "Still here" });
      await vi.advanceTimersByTimeAsync(500);
      await h.kernel.invoke("media.play", { args: [drum.value.id] });
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: drum.value.id });
      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: horn.value.id });
      await vi.advanceTimersByTimeAsync(2_000);
      const state = stateOf(h.kernel.snapshot());
      expect(state.active).toMatchObject({ itemId: state.speech!.id, paidId: state.paid[0]!.id });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("removing the clip mid-intro moves on to the message and leaves its level with no clip", async () => {
    vi.useFakeTimers();
    const voice = vi.fn(async (_text: string) => wav(2_000));
    const media = createMedia({ files: fakeFiles(), voice });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1, introId: horn.value.id }, { from: 4 }]) });
      h.chat({ type: "superchat", author: "Ana", text: "Removed intro" });
      await vi.advanceTimersByTimeAsync(500);
      expect(media.remove(horn.value.id)).toEqual({ ok: true, value: undefined });
      await vi.advanceTimersByTimeAsync(0);
      const state = stateOf(h.kernel.snapshot());
      expect(state.alertLevels).toEqual([{ from: 1 }, { from: 4 }]);
      expect(state.active).toMatchObject({ itemId: state.speech!.id, paidId: state.paid[0]!.id });
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("previews a level with its clip, then its alert, and End preview leaves the real queue alone", async () => {
    vi.useFakeTimers();
    const media = createMedia({ files: fakeFiles() });
    const h = await harness({ modules: [media.module] });
    try {
      const horn = media.add(upload());
      if (!horn.ok) throw new Error(horn.reason);
      await h.kernel.invoke("media.tts", { args: ["off"] });
      await h.kernel.invoke("media.alertLevels", { args: levels([{ from: 1 }, { from: 5, introId: horn.value.id }]) });
      expect(await h.kernel.invoke("media.previewAlert", { args: ["3"] })).toMatchObject({ ok: false, reason: "Choose a level from 1 to 2" });
      expect(await h.kernel.invoke("media.previewAlert", { args: ["2"] })).toEqual({ ok: true });
      const intro = stateOf(h.kernel.snapshot()).active!;
      expect(intro).toMatchObject({ itemId: horn.value.id, level: 2, size: 7, sample: { tier: 5, amount: "₹800" } });
      expect(intro.introFor).toBe(intro.sample!.id);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(stateOf(h.kernel.snapshot()).active).toMatchObject({ itemId: null, level: 2, size: 7, sample: { tier: 5 } });
      expect(stateOf(h.kernel.snapshot()).active).not.toHaveProperty("introFor");

      h.chat({ type: "superchat", author: "Ana", text: "Real" });
      expect(await h.kernel.invoke("media.endPreview", { args: [intro.sample!.id] })).toEqual({ ok: true });
      expect(stateOf(h.kernel.snapshot()).paid.map((message) => message.name)).toEqual(["Ana"]);
    } finally { await h.stop(); vi.useRealTimers(); }
  });

  it("keeps her levels and their clips across a restart, and drops a clip whose file is gone", async () => {
    const store = new MemoryStore();
    const files = fakeFiles();
    const first = createMedia({ files });
    const h1 = await harness({ modules: [first.module], store });
    const horn = first.add(upload("Air horn"));
    const meme = first.add(upload("Meme"));
    if (!horn.ok || !meme.ok) throw new Error("upload");
    expect(await h1.kernel.invoke("media.alertLevels", {
      args: levels([{ from: 1, introId: horn.value.id }, { from: 3 }, { from: 6, introId: meme.value.id }]),
    })).toEqual({ ok: true });
    await h1.stop();

    files.remove(horn.value);
    const h2 = await harness({ modules: [createMedia({ files }).module], store });
    try {
      expect(stateOf(h2.kernel.snapshot()).alertLevels).toEqual([{ from: 1 }, { from: 3 }, { from: 6, introId: meme.value.id }]);
    } finally { await h2.stop(); }
  });
});
