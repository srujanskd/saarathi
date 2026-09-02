import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Three bundles, no node_modules in the installer.
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

// The floating deck window is frameless, so the shell draws its own close
// button into the page and needs one channel back. A preload has to be a real
// file on disk that Electron loads into the renderer, which is why this is a
// third output and not part of main.
await build({
  ...common,
  entryPoints: [join(here, "src", "preload.ts")],
  outfile: join(here, "dist", "preload.cjs"),
  format: "cjs",
  external: ["electron"],
});

/**
 * The app's own Google credential, substituted into the bundle rather than
 * committed: the repo is public, and a secret in it is a secret on the
 * internet. It is not a way of keeping one -- whatever ships in the installer
 * is readable by anyone holding the installer -- it is a way of keeping it out
 * of git, where rotation costs a commit and scrapers read for a living.
 *
 * Blank is a supported build. She can paste a credential of her own on the
 * control page, which is the better answer anyway: the daily quota belongs to
 * the Google project the credential came from, so hers is an allowance nobody
 * else can spend. So this warns rather than failing -- `release.yml` is where
 * a tag is held to a higher standard than a local `pnpm dist`.
 */
const googleClient = {
  id: process.env.GOOGLE_CLIENT_ID ?? "",
  secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
};
if (!dev && !(googleClient.id && googleClient.secret)) {
  console.warn(
    "build: no GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET, so this build ships no sign-in of its own.\n" +
      "       She can still paste her own on the control page. Set both to compile one in.",
  );
}

await build({
  ...common,
  entryPoints: [join(here, "..", "server", "src", "main.ts")],
  outfile: join(here, "dist", "server.mjs"),
  // Replaced where `youtube-oauth.ts` reads them, which is why that file spells
  // out `process.env.X` rather than reaching through a parameter.
  define: {
    "process.env.GOOGLE_CLIENT_ID": JSON.stringify(googleClient.id),
    "process.env.GOOGLE_CLIENT_SECRET": JSON.stringify(googleClient.secret),
  },
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
