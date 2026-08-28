import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * One HTML file per surface rather than a router, because OBS loads each
 * overlay as its own browser source and a browser source is a URL, not a
 * route. It also means a static file server needs no SPA fallback: the
 * Fastify static plugin in production serves these as plain files.
 */
export default defineConfig({
  // Every URL in the built pages is relative to the page itself, for the same
  // reason nothing here names a host: the server serves these at the root, a
  // pages host may serve them from a subpath, and neither gets to be assumed.
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "index.html"),
        overlay: resolve(import.meta.dirname, "overlay.html"),
        control: resolve(import.meta.dirname, "control.html"),
      },
    },
  },
  server: {
    // Her phone and OBS both load these off the LAN, never off localhost.
    host: "0.0.0.0",
  },
});
