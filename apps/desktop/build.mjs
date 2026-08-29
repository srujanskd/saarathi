import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Two bundles, no node_modules in the installer.
 *
 * That is the whole answer to the pnpm hazard the plan flags: electron-builder
 * does not reliably walk pnpm's symlinked tree, and the usual fix is a scoped
 * node-linker=hoisted for the packaging step. Bundling instead means there is
 * no tree to walk -- `files` is dist plus resources, and every runtime
 * dependency is already inside one of the two files.
 */

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");

rmSync(join(here, "dist"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  // Electron 40 carries Node 22, and so does the engines field at the root.
  target: "node22",
  sourcemap: dev,
  minify: !dev,
  logLevel: "info",
};

await build({
  ...common,
  entryPoints: [join(here, "src", "main.ts")],
  outfile: join(here, "dist", "main.cjs"),
  format: "cjs",
  // The only thing that is genuinely provided by the runtime.
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: [join(here, "..", "server", "src", "main.ts")],
  outfile: join(here, "dist", "server.mjs"),
  // ESM, not CJS: the server's composition root is top-level await from its
  // first line, and esbuild cannot express that in CJS.
  format: "esm",
  // Bundled CJS dependencies still reach for these, and an ESM bundle has
  // neither. Fastify's plugin loading is the one that notices.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirname_of } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirname_of(__filename);",
    ].join("\n"),
  },
});

console.log(`built ${dev ? "dev" : "production"} bundles into dist/`);
