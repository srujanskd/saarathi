import { MAX_CHALLENGES, WHEEL_ID, type WheelState } from "@saarathi/shared";
import { controlUrl, expect, test } from "./helpers/fixtures.js";

/**
 * The control page is the same IRL rule as the overlay: the server address
 * arrives as `?server=`, because her phone is not the machine running the
 * server and will not be the day she is outside.
 *
 * Clicking Spin and sending mock chat are here because a socket client cannot
 * prove the buttons are wired. Everything those buttons *do* is already
 * proven in the server's own tests.
 */

test("renders a spin when the server address arrives as a URL parameter", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("wheel-result")).toContainText("Nothing on the wheel yet");

  await page.getByTestId("wheel-spin").click();
  await expect(page.getByTestId("wheel-result")).not.toContainText("Nothing on the wheel yet");

  const snapshot = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  const spin = snapshot.modules[WHEEL_ID]?.spin;
  expect(spin).toBeTruthy();

  await expect(page.getByTestId("wheel-result")).toContainText(spin!.label);
  await expect(page.getByTestId("wheel-result")).toHaveAttribute("data-phase", /spinning|landed/);
});

test("sends mock chat from the panel, so a spin can be tested without YouTube", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.getByTestId("mock-author").fill("anita");
  await page.getByTestId("mock-text").fill("!spin");
  await page.getByTestId("mock-send").click();

  await expect(page.getByTestId("chat-log")).toContainText("anita");
  await expect(page.getByTestId("chat-log")).toContainText("!spin");
  await expect(page.getByTestId("wheel-result")).not.toContainText("Nothing on the wheel yet");

  const snapshot = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  expect(snapshot.modules[WHEEL_ID]?.spin?.by).toBe("anita");
  await expect(page.getByTestId("wheel-result")).toContainText(
    snapshot.modules[WHEEL_ID]!.spin!.label,
  );
});

/**
 * The installed app is launched from the manifest's `start_url`, which is a
 * static file and cannot carry her address. So the address she gave the page
 * once has to survive a launch that has no query on it, or installing the
 * control page from anywhere but the server hands her an app pointed at the
 * wrong host -- outdoors, which is the one place she cannot fix it.
 */
test("launches from the home screen and still finds the server", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  // What Chrome opens for `start_url`: the page, no parameter.
  await page.goto(`${pages.origin}/control.html`);
  await expect(page.getByTestId("status")).toHaveText("Connected");
  await expect(page.getByTestId("wheel-card")).toBeVisible();
});

test("takes a new address over a remembered one, so there is a way back out", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(`${pages.origin}/control.html?server=http://127.0.0.1:1`);
  await expect(page.getByTestId("status")).toHaveAttribute("data-complain", "true", {
    timeout: 15_000,
  });

  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");
});

test("edits challenges without freezing the textarea against the server", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.getByTestId("wheel-card").locator(".fold > summary").click();
  const textarea = page.getByTestId("wheel-challenges");
  const before = await textarea.inputValue();

  await textarea.fill("10 burpees\n30s plank");
  await expect(page.getByTestId("wheel-unsaved")).toBeVisible();

  // The way out of an edit, which is the half a one-way door is missing.
  await page.getByTestId("wheel-revert").click();
  await expect(page.getByTestId("wheel-unsaved")).toHaveCount(0);
  await expect(textarea).toHaveValue(before);

  await textarea.fill("10 burpees\n30s plank");
  await page.getByTestId("wheel-save").click();
  await expect(page.getByTestId("wheel-unsaved")).toHaveCount(0);

  const snapshot = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  expect(snapshot.modules[WHEEL_ID]?.challenges).toEqual(["10 burpees", "30s plank"]);

  // The point of the whole exercise. Once she has saved, the server owns the
  // list again, so a change made anywhere else -- her other phone, the deck,
  // a reconnect snapshot -- lands in this textarea. A draft that outlives its
  // save freezes this page on her old text and nothing ever says so.
  const elsewhere = await page.context().newPage();
  await elsewhere.goto(controlUrl(pages, saarathi));
  await expect(elsewhere.getByTestId("status")).toHaveText("Connected");
  await elsewhere.getByTestId("wheel-card").locator(".fold > summary").click();
  await elsewhere.getByTestId("wheel-challenges").fill("50 jumping jacks");
  await elsewhere.getByTestId("wheel-save").click();

  await expect(textarea).toHaveValue("50 jumping jacks");
  await elsewhere.close();
});

test("says so, visibly, when the address in the URL goes nowhere", async ({ page, pages }) => {
  await page.goto(`${pages.origin}/control.html?server=http://127.0.0.1:1`);

  await expect(page.getByTestId("status")).toHaveAttribute("data-complain", "true", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("127.0.0.1:1");
});

/**
 * The cap is the server's rule and the server's tests prove it. What only a
 * browser can show is that she finds out before she taps: the fold counts the
 * text in the box rather than the list on the server, and a refused save
 * leaves that text where she can fix it instead of snapping back.
 */
test("says a list is too long before she saves it, and keeps it when refused", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(controlUrl(pages, saarathi));
  await expect(page.getByTestId("status")).toHaveText("Connected");

  await page.getByTestId("wheel-card").locator(".fold > summary").click();
  const textarea = page.getByTestId("wheel-challenges");
  const before = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  const saved = before.modules[WHEEL_ID]!.challenges;

  const tooMany = Array.from({ length: MAX_CHALLENGES + 1 }, (_, i) => `challenge ${i}`);
  const overCap = `A wheel holds ${MAX_CHALLENGES} challenges \u2014 that list has ${tooMany.length}`;
  await textarea.fill(tooMany.join("\n"));

  // The complaint is about what she typed, while the server still holds the
  // old list. Counting the saved list would say nothing until after the save.
  await expect(page.getByTestId("wheel-count")).toHaveText(overCap);

  await page.getByTestId("wheel-save").click();
  await expect(page.getByTestId("wheel-notice")).toContainText(overCap);
  await expect(textarea).toHaveValue(tooMany.join("\n"));
  await expect(page.getByTestId("wheel-unsaved")).toBeVisible();

  const after = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  expect(after.modules[WHEEL_ID]?.challenges).toEqual(saved);

  // Dropping one line is all it takes, and the fold stops complaining first.
  await textarea.fill(tooMany.slice(0, MAX_CHALLENGES).join("\n"));
  await expect(page.getByTestId("wheel-count")).toHaveText(`${MAX_CHALLENGES} challenges`);
  await page.getByTestId("wheel-save").click();
  await expect(page.getByTestId("wheel-unsaved")).toHaveCount(0);
});
