import { readFileSync } from "node:fs";
import { CORE_ACTIONS, MEDIA_ID, type DeckSlot, type MediaItem, type MediaState, type Snapshot } from "@saarathi/shared";
import { controlUrl, deckUrl, expect, overlayUrl, test } from "./helpers/fixtures.js";

// A valid 1×1 PNG. The browser has to decode it, not merely receive bytes,
// or this test would pass against the same blank OBS source the user saw.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("a media deck button makes its PNG visible in the Media OBS source", async ({
  context,
  page: overlay,
  pages,
  saarathi,
}) => {
  const query = new URLSearchParams({ label: "Badge", durationMs: "5000", volume: "0.8" });
  const uploaded = await saarathi.raw(`/api/media?${query}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${saarathi.controlToken}`,
      "content-type": "image/png",
    },
    body: PNG,
  });
  expect(uploaded.status).toBe(201);
  const item = ((await uploaded.json()) as { item: MediaItem }).item;

  const slot: DeckSlot = {
    action: `${MEDIA_ID}.play`,
    args: [item.id],
    label: item.label,
    icon: "▶",
  };
  expect(
    await saarathi.invoke({
      action: CORE_ACTIONS.deckSet,
      args: [JSON.stringify([slot])],
    }),
  ).toEqual({ ok: true });

  await overlay.goto(overlayUrl(pages, saarathi, MEDIA_ID));
  const deck = await context.newPage();
  await deck.goto(deckUrl(pages, saarathi));
  await expect(deck.getByTestId("status")).toHaveText("Connected");
  await deck.getByTestId("deck-key").click();

  const image = overlay.getByTestId("media-image");
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await deck.close();
});

// OBS enables this policy in obs-browser/browser-app.cpp. No clicks should be
// needed inside a browser source for a remote deck button to produce sound.
test.use({ launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] } });

// The MP3 and Opus fixtures are generated 440 Hz tones, ten seconds each:
// ffmpeg -f lavfi -i sine=frequency=440:duration=10 -c:a libmp3lame -b:a 32k tone.mp3
// ffmpeg -f lavfi -i sine=frequency=440:duration=10 -c:a libopus -b:a 16k tone.ogg
test.describe("audio in OBS", () => {
  for (const [extension, mimeType] of [["wav", "audio/wav"], ["mp3", "audio/mpeg"], ["ogg", "audio/ogg"]] as const) {
    test(`${extension}: uploads, plays from control and deck, rejoins and stops`, async ({
      context, page: overlay, pages, saarathi,
    }) => {
      const control = await context.newPage();
      await control.goto(controlUrl(pages, saarathi));
      const card = control.getByTestId("media-card");
      await card.getByText("Add a clip", { exact: true }).click();
      await card.locator('input[type="file"]').setInputFiles({
        name: `Test tone.${extension}`, mimeType,
        buffer: extension === "wav" ? tone() : readFileSync(new URL(`./fixtures/tone.${extension}`, import.meta.url)),
      });
      await card.getByRole("button", { name: "Add clip", exact: true }).click();
      await expect(card.getByTestId("media-notice")).toContainText("Test tone is ready");
      await overlay.goto(overlayUrl(pages, saarathi, MEDIA_ID));
      await card.getByRole("button", { name: "Play live", exact: true }).click();
      const audio = overlay.getByTestId("media-audio");
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) =>
        !element.paused && !element.muted && element.volume === 0.8 &&
        element.error === null && element.currentTime > 0.2,
      )).toBe(true);

      // Decoding bytes and advancing playback are separate checks: a silent or
      // invalid fixture must not make this test claim sound was produced.
      expect(await audio.evaluate(async (element: HTMLAudioElement) => {
        const response = await fetch(element.src);
        const decoder = new AudioContext();
        try {
          const decoded = await decoder.decodeAudioData(await response.arrayBuffer());
          return decoded.getChannelData(0).some((sample) => Math.abs(sample) > 0.1);
        } finally {
          await decoder.close();
        }
      })).toBe(true);
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(1);
      await overlay.reload();
      await expect.poll(async () => {
        const snapshot = await saarathi.get("/api/state") as Snapshot;
        const cue = (snapshot.modules[MEDIA_ID] as MediaState).active;
        if (!cue) return false;
        const elapsed = (snapshot.serverNow - cue.startedAt) / 1000;
        return audio.evaluate((element: HTMLAudioElement, serverElapsed: number) =>
          !element.paused && Math.abs(element.currentTime - serverElapsed) < 0.5, elapsed,
        );
      }).toBe(true);
      await card.getByRole("button", { name: "Stop all" }).click();
      await expect(audio).toHaveCount(0);
      await card.getByRole("button", { name: "On the deck" }).click();
      const deck = await context.newPage();
      await deck.goto(deckUrl(pages, saarathi));
      await expect(deck.getByTestId("status")).toHaveText("Connected");
      await deck.getByTestId("deck-key").first().click();
      await expect.poll(() => audio.evaluate((element: HTMLAudioElement) =>
        !element.paused && element.currentTime > 0.2,
      )).toBe(true);
      await card.getByRole("button", { name: "Stop all" }).click();
      await expect(audio).toHaveCount(0);
      await deck.close();
      await control.close();
    });
  }
});

function tone(): Buffer {
  const rate = 8_000;
  const samples = rate * 10;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF");
  data.writeUInt32LE(data.length - 8, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    data.writeInt16LE(Math.round(16_000 * Math.sin(2 * Math.PI * 440 * i / rate)), 44 + i * 2);
  }
  return data;
}
