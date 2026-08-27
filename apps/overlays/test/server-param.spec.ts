import { SPIN_DURATION_MS, WHEEL_ID, type WheelState } from "@saarathi/shared";
import { expect, overlayUrl, test } from "./helpers/fixtures.js";

/**
 * The one thing a socket client cannot check: that the page finds the server
 * through its URL rather than through the origin it was served from. Break
 * this and nothing fails until the day she is outside on her phone.
 */
test("renders a spin when the server address arrives as a URL parameter", async ({
  page,
  pages,
  saarathi,
}) => {
  await page.goto(overlayUrl(pages, saarathi, WHEEL_ID));

  // Nothing on the wheel yet, so nothing on her camera either.
  await expect(page.getByTestId("stage")).toHaveAttribute("data-phase", "hidden");

  const result = await saarathi.invoke({ action: "wheel.spin" });
  expect(result.ok).toBe(true);

  await expect(page.getByTestId("wheel")).toBeVisible();

  // What it shows has to be the challenge the server picked, not merely some
  // challenge: the overlay renders state, it does not choose.
  const snapshot = (await saarathi.get("/api/state")) as { modules: Record<string, WheelState> };
  const spin = snapshot.modules[WHEEL_ID]?.spin;
  expect(spin).toBeTruthy();

  await expect(page.getByTestId("result")).toContainText(spin!.label, {
    timeout: SPIN_DURATION_MS + 5_000,
  });
});

test("says so, visibly, when the address in the URL goes nowhere", async ({ page, pages }) => {
  // Port 1 is not something she will ever be running. A stack trace in a
  // console she never opens is not a failure message; this is.
  await page.goto(`${pages.origin}/overlay.html?module=${WHEEL_ID}&server=http://127.0.0.1:1`);

  await expect(page.getByTestId("status")).toHaveAttribute("data-visible", "true", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("127.0.0.1:1");
});
