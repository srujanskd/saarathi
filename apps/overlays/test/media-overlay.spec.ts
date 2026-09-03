import { CORE_ACTIONS, MEDIA_ID, type DeckSlot, type MediaItem } from "@saarathi/shared";
import { deckUrl, expect, overlayUrl, test } from "./helpers/fixtures.js";

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
