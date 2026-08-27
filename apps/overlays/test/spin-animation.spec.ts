import { SPIN_DURATION_MS, WHEEL_ID, type WheelState } from "@saarathi/shared";
import { expect, overlayUrl, runningAnimations, test } from "./helpers/fixtures.js";

/** Everything the compositor can do on its own. Anything else repaints the
 * whole browser source, and she pays for it in dropped frames mid-workout. */
const ALLOWED = new Set(["transform", "opacity"]);

/** Far enough into a six second spin that starting over would be obvious. */
const JOIN_AFTER_MS = 2_000;

/** Her phone, badly out of step with a server that is not on her machine. */
const CLOCK_SKEW_MS = 40_000;

test("a spin animates transform and opacity only, and stops when it lands", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(overlayUrl(pages, saarathi, WHEEL_ID));
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "hidden");

  expect(await runningAnimations(page)).toEqual([]);

  const result = await saarathi.invoke({ action: "wheel.spin" });
  expect(result.ok).toBe(true);

  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "spinning");

  const during = await runningAnimations(page);
  // Name the wheel's own animation, not just "something is animating": a fade
  // on the container would otherwise pass this while the wheel sat still.
  expect(
    during.some((animation) => animation.properties.includes("transform")),
    `nothing is rotating the wheel: ${JSON.stringify(during)}`,
  ).toBe(true);
  for (const animation of during) {
    for (const property of animation.properties) {
      expect(ALLOWED, `${animation.id} animates ${property}`).toContain(property);
    }
  }

  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "landed", {
    timeout: SPIN_DURATION_MS + 5_000,
  });

  // A landed wheel is a static composited layer. If anything is still on the
  // browser's animation books here, it is repainting for the rest of the
  // stream for a wheel that finished turning.
  await expect
    .poll(async () => (await runningAnimations(page)).length, { timeout: 5_000 })
    .toBe(0);
});

test("an overlay opened mid-spin joins the spin already in progress", async ({
  page,
  pages,
  saarathi,
}) => {
  // OBS reloading a browser source, or her phone waking up, two seconds into a
  // six second spin. The server is authoritative and says when the spin
  // started, so the overlay's job is to catch up, not to start over.
  const result = await saarathi.invoke({ action: "wheel.spin" });
  expect(result.ok).toBe(true);

  // A deliberate wait, not a poll: elapsed wall-clock time is the subject of
  // this test, so there is no predicate to wait on. What must not be hardcoded
  // is the assertion -- it comes from the server's own startedAt below, so this
  // number can change without quietly making the test vacuous.
  await new Promise((resolve) => setTimeout(resolve, JOIN_AFTER_MS));

  await page.goto(overlayUrl(pages, saarathi, WHEEL_ID));
  await expect(page.getByTestId("wheel")).toBeVisible();

  const elapsed = await page.evaluate(
    () => document.getAnimations().find((a) => a.constructor.name === "Animation")?.currentTime ?? 0,
  );

  const snapshotAtJoin = (await saarathi.get("/api/state")) as {
    serverNow: number;
    modules: Record<string, WheelState>;
  };
  const serverElapsed = snapshotAtJoin.serverNow - snapshotAtJoin.modules[WHEEL_ID]!.spin!.startedAt;

  // Within a second of where the server says the spin is. Loose enough for a
  // page load and a CI runner, tight enough that starting over from zero fails.
  expect(Number(elapsed)).toBeGreaterThan(serverElapsed - 1_000);
  expect(Number(elapsed)).toBeLessThan(serverElapsed + 1_000);

  // And it still lands on the challenge the server picked, not a fresh one.
  const snapshot = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  await expect(page.getByTestId("result")).toContainText(
    snapshot.modules[WHEEL_ID]!.spin!.label,
    { timeout: SPIN_DURATION_MS },
  );
});

/**
 * The clock the overlay does its maths against.
 *
 * `?server=` exists so the server can be a VPS while the page runs on her
 * phone, which means the page's own `Date.now()` is not the server's. This is
 * the one thing a socket client cannot prove: the correction has to reach
 * `animation.currentTime`, and only a browser has one.
 */
test("a spin joins correctly on a client whose clock is 40 seconds out", async ({
  page,
  pages,
  saarathi,
}) => {
  // Skew the page's clock before any of its script runs. `Date.now` is the only
  // thing to move: it is what the overlay derives elapsed from, and leaving the
  // Date constructor alone keeps socket.io on a clock it can still reason about.
  await page.addInitScript((skew) => {
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + skew;
  }, CLOCK_SKEW_MS);

  const result = await saarathi.invoke({ action: "wheel.spin" });
  expect(result.ok).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, JOIN_AFTER_MS));

  await page.goto(overlayUrl(pages, saarathi, WHEEL_ID));

  // Uncorrected, this phone computes an elapsed 40s past the hold and renders
  // nothing at all: a live spin, invisible to chat.
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "spinning");
  await expect(page.getByTestId("wheel")).toBeVisible();

  const skewed = await page.evaluate(() => Date.now());
  const snapshot = (await saarathi.get("/api/state")) as { serverNow: number };
  expect(skewed - snapshot.serverNow).toBeGreaterThan(CLOCK_SKEW_MS / 2);

  const elapsed = await page.evaluate(
    () => document.getAnimations().find((a) => a.constructor.name === "Animation")?.currentTime ?? 0,
  );
  // Joined where the spin actually is, not 40 seconds past the end of it.
  expect(Number(elapsed)).toBeGreaterThan(JOIN_AFTER_MS - 1_000);
  expect(Number(elapsed)).toBeLessThan(SPIN_DURATION_MS);

  // And it still lands on what the server picked.
  const state = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  await expect(page.getByTestId("result")).toContainText(state.modules[WHEEL_ID]!.spin!.label, {
    timeout: SPIN_DURATION_MS,
  });
});
