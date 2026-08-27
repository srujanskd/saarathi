import { test as base, type Page } from "@playwright/test";
import { startServer, type RunningServer } from "../../../server/test/e2e/helpers/server.js";
import { startPages, type PageServer } from "./pages.js";

/**
 * A real Saarathi server and a plain file server on two different origins,
 * which is the arrangement these specs are about. `startServer` is the same
 * helper the server's e2e project uses: it takes a port from the OS, puts
 * STATE_FILE in a temp directory, and stops the child by the PID it spawned.
 */
export const test = base.extend<{ saarathi: RunningServer; pages: PageServer }>({
  saarathi: async ({}, use) => {
    const server = await startServer();
    await use(server);
    await server.stop();
  },
  pages: async ({}, use) => {
    const server = await startPages();
    await use(server);
    await server.stop();
  },
});

export const expect = base.expect;

/** The overlay URL as OBS would be given it: pages from one host, server from
 * another, joined only by the parameter. */
export function overlayUrl(pages: PageServer, saarathi: RunningServer, module: string): string {
  return `${pages.origin}/overlay.html?module=${module}&server=${encodeURIComponent(saarathi.origin)}`;
}

/** Animations the browser is actually running, and which properties each one
 * touches. Anything outside transform and opacity repaints the browser source. */
export function runningAnimations(page: Page): Promise<{ id: string; properties: string[] }[]> {
  return page.evaluate(() => {
    const METADATA = new Set(["offset", "computedOffset", "easing", "composite"]);
    return document.getAnimations().map((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      const keyframes = effect?.getKeyframes?.() ?? [];
      const properties = new Set<string>();
      for (const frame of keyframes) {
        for (const key of Object.keys(frame)) if (!METADATA.has(key)) properties.add(key);
      }
      return { id: animation.id || animation.constructor.name, properties: [...properties] };
    });
  });
}
