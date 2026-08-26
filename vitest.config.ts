import { defineConfig } from "vitest/config";

/**
 * Three projects, split by what they need rather than by what they cover.
 *
 * unit        pure functions. No clock, no store, no kernel. Milliseconds.
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
