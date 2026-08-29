import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

/**
 * One flat config for the whole workspace.
 *
 * Deliberately not type-aware. The rules that earn their keep here are
 * syntactic -- `no-explicit-any` and the hooks rules -- and a type-aware setup
 * would tie lint to three tsconfigs and make it slow enough that nobody runs
 * it locally. `pnpm typecheck` already reads the types.
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/data/**",
      "**/test-results/**",
      "**/playwright-report/**",
    ],
  },

  // TypeScript everywhere, plus the handful of first-party .mjs files that
  // build and package the tray app. Those never run in her build of anything,
  // but a typo in one of them is a release that does not happen.
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mjs"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: {
      // TypeScript resolves identifiers itself, and no-undef cannot see type
      // positions, so it only ever produces false positives on .ts.
      "no-undef": "off",
      // Underscore is the escape hatch for a signature that has to accept an
      // argument it does not use.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },

  // Overlays run in a browser and are the only React in the tree. Scoped to
  // src: the specs beside it drive React from Node, they do not contain any.
  {
    files: ["apps/overlays/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat["recommended-latest"]],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The mid-spin wedge bug was a stale dependency array. This is the rule
      // that would have caught it, so it fails the build rather than warning.
      "react-hooks/exhaustive-deps": "error",
    },
  },

  // Playwright specs drive a browser from Node: both sets of globals are real
  // in the same file, because the argument to page.evaluate runs over there.
  {
    files: ["apps/overlays/test/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // `async ({}, use) =>` is how Playwright declares a fixture that wants no
      // other fixture. There is no shorter way to write it.
      "no-empty-pattern": "off",
    },
  },

  // `youtube-chat-next` is untyped and this is the boundary that converts its
  // shapes into ours. AGENTS.md calls this the one place `any` is tolerated;
  // this is that rule, written down where it is enforced. If a second file
  // wants onto this list, normalize at the boundary instead.
  {
    files: ["apps/server/src/chat/youtube.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
