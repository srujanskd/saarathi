import { defineConfig } from "vitest/config";

/**
 * Five projects, split by what they need rather than by what they cover.
 *
 * unit        pure functions in the server. No clock, no store, no kernel.
 *             Milliseconds.
 * unit-desktop the same tier again, in the tray app -- which address to show
 *             her, what the menu says, how the server child is spawned.
 *             Electron itself is the one thing here nothing can boot, so the
 *             shell holds no decisions and this project holds all of them.
 * unit-overlays the same tier, in the overlay app. It is a second project only
 *             because a Vitest project has one root, and these live in another
 *             workspace. Pure functions only -- anything needing a browser
 *             belongs in apps/overlays/test/*.spec.ts, which Playwright runs.
 * integration a real Kernel over a MemoryStore and mock chat, in this process.
 *             Fake timers are allowed here, so it runs single-file at a time.
 * e2e         a real server process on an ephemeral port with a real
 *             socket.io-client. Slow, few, and the only place that proves
 *             reconnect and restart behave.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          root: "apps/server",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "unit-overlays",
          root: "apps/overlays",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "unit-desktop",
          root: "apps/desktop",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          root: "apps/server",
          include: ["test/integration/**/*.test.ts"],
          environment: "node",
          // Module state and fake timers do not survive being shared.
          isolate: true,
        },
      },
      {
        test: {
          name: "e2e",
          root: "apps/server",
          include: ["test/e2e/**/*.test.ts"],
          environment: "node",
          // Booting a server per file is slow; do not also do it in parallel
          // on a laptop that is streaming.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
