import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PAID_QUEUE, MEDIA_ID, PAID_ALERT_MS, type MediaState } from "@saarathi/shared";
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
      expect(voice.mock.calls).toMatchObject([["Ana sent $5.00. Keep going!", expect.any(AbortSignal)]]);
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
      expect(voice).toHaveBeenNthCalledWith(2, "Bo sent $10.00. One more rep!", expect.any(AbortSignal));
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
      expect(voice).toHaveBeenCalledWith("Ana sent $5.00. First", expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(voice).toHaveBeenLastCalledWith("Bo sent $5.00. Second", expect.any(AbortSignal));
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
      expect(voice).toHaveBeenLastCalledWith("Bo sent $5.00. Second", expect.any(AbortSignal));
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
      expect(voice).toHaveBeenLastCalledWith("Bot sent $5.00. Thank you!", expect.any(AbortSignal));
      await vi.advanceTimersByTimeAsync(PAID_ALERT_MS);
      expect(stateOf(h.kernel.snapshot()).active).toBeNull();
      await h.kernel.invoke(`${MEDIA_ID}.checkFirst`, { args: ["off"] });
      await vi.advanceTimersByTimeAsync(0);
      expect(voice).toHaveBeenLastCalledWith("Ana sent $5.00. Held", expect.any(AbortSignal));
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
