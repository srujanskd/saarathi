import { WHEEL_ID, type WheelState } from "@saarathi/shared";
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

test("says so, visibly, when the address in the URL goes nowhere", async ({ page, pages }) => {
  await page.goto(`${pages.origin}/control.html?server=http://127.0.0.1:1`);

  await expect(page.getByTestId("status")).toHaveAttribute("data-complain", "true", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("status")).toContainText("127.0.0.1:1");
});
