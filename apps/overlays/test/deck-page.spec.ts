import type { CoreState, DeckSlot, WheelState } from "@saarathi/shared";
import { controlUrl, deckUrl, expect, test } from "./helpers/fixtures.js";

/**
 * The deck is the surface most likely to be on the far side of the LAN from
 * the server -- a tablet propped on a rack, her phone in her pocket -- so the
 * `?server=` rule matters here more than anywhere.
 *
 * Everything the buttons *do* is proven over a socket in the server's own e2e
 * project, including that a press from this surface is recorded as `deck`.
 * What is left, and what only a browser can answer, is whether the grid she
 * saved on one page reaches the other one and whether pressing it is wired to
 * anything at all.
 */

const grid = (slots: Partial<DeckSlot>[]) =>
  ({ action: "core.deckSet", args: [JSON.stringify(slots)] });

test("renders the saved grid when the server address arrives as a URL parameter", async ({
  page,
  pages,
  saarathi,
}) => {
  await saarathi.invoke(grid([{ action: "wheel.spin", label: "Spin", icon: "🎡" }]));

  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("deck-key")).toContainText("Spin");
  await expect(page.getByTestId("deck-key")).toContainText("🎡");
});

test("presses a button, which is the one thing a socket client cannot prove", async ({
  page,
  pages,
  saarathi,
}) => {
  await saarathi.invoke(grid([{ action: "wheel.spin", label: "Spin" }]));

  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await page.getByTestId("deck-key").click();

  // The page renders no wheel state at all, so the confirmation is the only
  // thing on screen that says the press landed. The server is the authority.
  await expect(page.getByTestId("deck-notice")).toContainText("Spin");
  const state = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  expect(state.modules.wheel?.spin?.via).toBe("deck");
});

/**
 * A button is an action *and its arguments*, and the arguments are the half
 * that makes two buttons different. Dropping them on the way out of the grid
 * is a mutation nothing else here notices: every other button in this file
 * takes none.
 */
test("presses a button that carries arguments, and the action gets them", async ({
  page,
  pages,
  saarathi,
}) => {
  await saarathi.invoke(
    grid([{ action: "wheel.setChallenges", args: ["20 squats", "30s plank"], label: "Load list" }]),
  );

  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await page.getByTestId("deck-key").click();
  await expect(page.getByTestId("deck-notice")).toContainText("Load list");

  const state = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  expect(state.modules.wheel?.challenges).toEqual(["20 squats", "30s plank"]);
});

test("says so when there is nothing on it yet, rather than showing her a blank page", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("deck-empty")).toContainText("No buttons yet");
});

/**
 * The round trip the whole feature is: she arranges the grid on the page she
 * can look at properly, and the page she actually presses redraws itself. Two
 * browser contexts, because that is what she has -- a phone in her hand and a
 * tablet on the rack.
 */
test("a button added on the control page turns up on a deck nobody touched", async ({
  page,
  context,
  pages,
  saarathi,
}) => {
  const deck = await context.newPage();
  await deck.goto(deckUrl(pages, saarathi));
  await expect(deck.getByTestId("deck-empty")).toBeVisible();

  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.getByTestId("deck-count").click();
  await page.getByTestId("deck-add-action").selectOption("wheel.spin");
  await page.getByTestId("deck-add").click();
  await page.getByTestId("deck-slot-icon").fill("🎡");
  await expect(page.getByTestId("deck-unsaved")).toBeVisible();
  await page.getByTestId("deck-save").click();
  await expect(page.getByTestId("deck-unsaved")).toBeHidden();

  const saved = (await saarathi.get("/api/state")) as { core: CoreState };
  expect(saved.core.deck.slots).toHaveLength(1);
  expect(saved.core.deck.slots[0]!.icon).toBe("🎡");

  await expect(deck.getByTestId("deck-key")).toHaveCount(1);
  await expect(deck.getByTestId("deck-key")).toContainText("🎡");
  await deck.close();
});

/** The installed deck is launched from its manifest's `start_url`, which is a
 * static file and cannot carry her address. Same rule the control page has,
 * and it is a separate page with a separate manifest, so it needs its own
 * proof. */
test("launches from the home screen and still finds the server", async ({
  page,
  pages,
  saarathi,
}) => {
  await saarathi.invoke(grid([{ action: "wheel.spin", label: "Spin" }]));

  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.goto(`${pages.origin}/deck.html`);
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("deck-key")).toHaveCount(1);
});

/** Two of her pages on one origin, and the link between them is the easiest
 * place in the app to drop the address. */
test("links between the two pages without losing the server address", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.getByTestId("deck-card").getByRole("link", { name: "open the deck" }).click();
  await expect(page.getByTestId("deck-empty")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("Connected");
  expect(page.url()).toContain(`server=${encodeURIComponent(saarathi.origin)}`);

  // And back, which is the only route from a deck with the wrong buttons on it
  // to the page that can fix them.
  await page.getByTestId("deck-to-control").click();
  await expect(page.getByTestId("deck-card")).toBeVisible();
  await expect(page.getByTestId("status")).toHaveText("Connected");
  expect(page.url()).toContain(`server=${encodeURIComponent(saarathi.origin)}`);
});
