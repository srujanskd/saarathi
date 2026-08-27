import { defineConfig, devices } from "@playwright/test";

/**
 * The browser layer, and the only one there is.
 *
 * Everything a socket client can prove is already proven in the server's e2e
 * project, and cheaper. These specs exist for the two things it cannot reach:
 * that a page takes the server address from its URL rather than its origin,
 * and that a spin animates on the compositor and then stops.
 *
 * Chromium only, because OBS embeds CEF and CEF is Chromium. Testing her
 * overlays in Firefox would be testing a browser she will never run them in.
 */
export default defineConfig({
  testDir: "./test",
  // Only .spec.ts. test/unit holds Vitest files, which Playwright's default
  // pattern would otherwise pick up and fail on.
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? "github" : "list",
  use: { ...devices["Desktop Chrome"] },
  projects: [{ name: "chromium" }],
});
