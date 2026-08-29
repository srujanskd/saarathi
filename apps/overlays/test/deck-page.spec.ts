import { CORE_ACTIONS, type CoreState, type DeckSlot, type WheelState } from "@saarathi/shared";
import { startFakeObs, type FakeObs } from "../../server/test/e2e/helpers/fake-obs.js";
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
  ({ action: CORE_ACTIONS.deckSet, args: [JSON.stringify(slots)] });

test("renders a saved button and presses it, which a socket client cannot prove", async ({
  page,
  pages,
  saarathi,
}) => {
  await saarathi.invoke(grid([{ action: "wheel.spin", label: "Spin", icon: "🎡" }]));

  await page.goto(deckUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("deck-key")).toContainText("Spin");
  await expect(page.getByTestId("deck-key")).toContainText("🎡");
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

/**
 * Two cards write buttons -- the deck card arranges them, the OBS card adds a
 * scene -- and only a browser can prove they are looking at the same grid,
 * because the bug lives between two React components and never reaches the
 * socket. Held by one card, a draft shadows the server for that card alone: the
 * scene lands on the server, never appears in the list she is reading, and her
 * next Save deletes it. She watched it work and then lost it.
 *
 * This is the only spec here that needs an OBS, so it brings its own.
 */
let obs: FakeObs | null = null;

test.afterEach(async () => {
  await obs?.close();
  obs = null;
});

test("keeps a scene added while she is part-way through arranging the deck", async ({
  page,
  pages,
  saarathi,
}) => {
  obs = await startFakeObs({ scenes: ["Workout", "BRB"] });
  // The same way her control page points the server at an OBS on another
  // machine, which is the one path a test can take: autodetect is off here.
  expect(
    await saarathi.invoke({
      action: CORE_ACTIONS.obsSettings,
      args: ["127.0.0.1", String(obs.port), ""],
    }),
  ).toEqual({ ok: true });

  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("obs-scenes")).toBeVisible();

  // An arrangement she has not saved yet.
  await page.getByTestId("deck-count").click();
  await page.getByTestId("deck-add-action").selectOption("wheel.spin");
  await page.getByTestId("deck-add").click();
  await page.getByTestId("deck-slot-label").fill("Go");
  await expect(page.getByTestId("deck-unsaved")).toBeVisible();

  // ...and a scene added from the other card while it is open.
  await page.getByText("Put a scene on her deck").click();
  await page.getByTestId("obs-add-scene").filter({ hasText: "BRB" }).click();

  // It has to turn up in the list she is reading, or the next Save silently
  // takes it away again.
  const rows = page.getByTestId("deck-slot-label");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveValue("Go");
  await expect(rows.nth(1)).toHaveValue("BRB");
  await expect(page.getByTestId("obs-notice")).toContainText("BRB");
  // Not saved behind her back: one Save, from the card with the Save button.
  expect(((await saarathi.get("/api/state")) as { core: CoreState }).core.deck.slots).toHaveLength(
    0,
  );

  await page.getByTestId("deck-save").click();
  await expect(page.getByTestId("deck-unsaved")).toBeHidden();

  const saved = ((await saarathi.get("/api/state")) as { core: CoreState }).core.deck.slots;
  expect(saved.map((slot) => slot.label)).toEqual(["Go", "BRB"]);
  expect(saved[1]).toMatchObject({ action: CORE_ACTIONS.obsScene, args: ["BRB"] });
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
