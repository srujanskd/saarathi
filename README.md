# Saarathi

Saarathi (ಸಾರಥಿ) is Kannada for charioteer, the sidekick who drives so the hero can fight.

It is a set of open-source stream tools for one person: a fitness streamer on YouTube whose
format is chat-interactive workouts. Chat types `!spin`, a wheel picks "20 squats", she does
them. Everything else in the repo exists to make that loop richer.

Two constraints shape every decision here:

**She is not technical, and she is on Windows.** No terminal, ever. The whole thing ships as an
Electron tray app: install once, click an icon, it starts with Windows.

**She wants to stream IRL from an Android phone later.** So nothing assumes localhost or a
desktop browser. Every control surface is a web page, and the server runs unchanged on her PC
today or a cloud VPS later.

## What is in here

One TypeScript monorepo. A Fastify + Socket.IO server reads YouTube chat and drives OBS. Each
tool is a React page: an overlay for OBS to load as a browser source, and a control page for
her phone.

Games are plugins, not features. The challenge wheel is the first game module. A boss fight or
workout bingo is a new folder, never a refactor.

The full design, the licensing research behind the stack, and the roadmap live in
`docs/plan.html`. Open it in a browser. It is gitignored, so it is a local working document
rather than something you get with a clone.

## Status

Early. Phases 1 and 2 of four.

The server is built around the game module contract and runs. Chat events in, module state out,
snapshot-synced over Socket.IO. Two modules ship with it: the challenge wheel and a chat log.

`apps/overlays` has three pages. The wheel overlay is the browser source OBS loads at
`overlay.html?module=wheel`. The control page is `control.html`, the phone page she drives
the stream from, with a mock-chat panel. The deck is `deck.html`, the button grid she arranges
from the control page. All three render server state and decide nothing.

`apps/desktop` is the tray app that makes the rest of it clickable: it starts the server, keeps
a menu that says what the server is doing, shows a QR code her phone can scan, and updates
itself from the GitHub release. Install once, never open a terminal.

The deck has all three of its faces now, and they are one grid: the touch page above, a global
hotkey per button (`Ctrl+Alt+0-9` and `F13-F24`, picked from a list because she arranges the
grid on a phone), and a frameless always-on-top window the tray floats over OBS. The tray is a
client of its own server for this — a hotkey opens a socket to `127.0.0.1` and calls the same
`invoke` her phone does, so there is one code path into an action rather than two.

## How it fits together

Events in, actions out. Every trigger she has — `!spin` in chat, a Super Chat or a tip, a deck
button, a hotkey, the control page — resolves to the same named action (`wheel.spin`), so there
is no second code path to keep in sync. Cooldowns, prices and permissions are declared as data
on the command binding and enforced in one place, which is why a paid trigger is not rate-limited
by the chat cooldown.

Modules own a state slice and nothing else. They cannot touch a socket, a file or a save timer:
they call `setState`, and the core coalesces the broadcast and persists the keys the module
declared durable. Adding a module adds zero socket events.

Free triggers are refused when the wheel is busy; paid ones queue and run themselves when it
frees up, and the queue is persisted. A viewer who spent money or gains never gets nothing.

State is the truth; effects are advisory. Anything visible for more than a moment lives in state
with a timestamp — a spin is `{ label, startedAt, durationMs }` — so an overlay that connects
two seconds into a six-second spin renders it mid-rotation instead of missing it. Effects
(a sound, an alert) are one-shot, and missing one breaks nothing.

## Running it

```bash
pnpm install
pnpm dev           # server on 4400, overlay pages on Vite
pnpm typecheck
pnpm lint          # eslint, warnings included; `pnpm lint:fix` applies what it can
```

The server listens on port 4400 and binds `0.0.0.0`, so a phone on the same Wi-Fi reaches it at
`http://<pc-ip>:4400`. Run `pnpm build` once and it serves the overlay pages too, which is how
she runs it: one address for OBS, her phone and the server.

Pages never assume they were served by the server. The address arrives as `?server=`, falling
back to wherever the page came from, so the same build works with OBS on her PC, her phone on
the LAN, and the server on a VPS the day she streams IRL:

```
http://<server>:4400/overlay.html?module=wheel
http://<server>:4400/control.html
http://<pages-host>/overlay.html?module=wheel&server=http://<server>:4400
http://<pages-host>/control.html?server=http://<server>:4400
```

## Packaging it

```bash
pnpm dist                                  # the Windows installer, from any platform
pnpm --filter @saarathi/desktop dev        # the tray app, against this checkout
pnpm --filter @saarathi/desktop dist:local # a build for whatever you are on
```

`pnpm dist` builds the pages, bundles the server, the tray and its preload into three files with
esbuild, and hands them to electron-builder as an NSIS installer. Nothing ships a
`node_modules`, which is what keeps electron-builder from having to walk pnpm's symlinked tree.

The installer is per-user and one-click: no admin prompt, no options page, and auto-update
replaces it without one either. Her state lives in `%APPDATA%/Saarathi`, never in the install
directory, and the server's log is beside it — "Open logs folder" in the tray menu is the whole
support story.

Releases carry it: the `v*` tag builds the installer on a Windows runner and uploads it with
`latest.yml`, which is the file `electron-updater` polls. The version comes from the root
`package.json` rather than the package it is built from, because the product is one version.

With no YouTube config it runs on mock chat, which is how you develop. To point it at a real
stream, set one of these:

```bash
YT_CHANNEL_ID=UC...   # watches the channel, reconnects when she goes live
YT_LIVE_ID=...        # attaches to one specific broadcast
```

Reading chat needs no API key and no OAuth. It goes through `youtube-chat-next`, which reads
what the web page reads. The official API is only for sending bot replies and moderation
actions later, because polling chat through it burns the 10k/day quota in an afternoon.

## Layout

```
apps/server/src/
  main.ts              composition root; the only file that reads process.env
  core/kernel.ts       wires registry + trigger gate + chat adapters; takes its deps
  core/registry.ts     modules, state slices, event fan-out, enabled/armed lifecycle
  core/triggers.ts     command parsing and the permission/cooldown/price gate
  core/sync.ts         the only file that imports socket.io
  core/store.ts        namespaced slices, atomic debounced writes
  core/gains.ts        the channel currency ledger
  core/obs.ts          the OBS seam, and the live obs-websocket connection in it
  core/obs-config.ts   OBS's own config file, and the words her card shows
  chat/                the one platform-specific layer: adapter.ts, youtube.ts, mock.ts
  modules/wheel/       the first game module; rules.ts is pure and testable
  modules/chatlog/     the second, and the proof the contract holds
apps/overlays/
  overlay.html         one browser source per module: ?module=wheel
  control.html         her phone: wheel card, chat log, mock-chat panel
  src/core/            cards for core services rather than modules: OBS
  src/lib/serverUrl.ts the only thing that decides where the server is
  src/lib/connection.ts one socket, snapshot-on-connect, no game logic
  src/modules/         client half of the module contract: one entry per game,
                       its overlay and its card together
  test/                Playwright: the things a socket client cannot check
apps/desktop/
  src/main.ts          the only file that imports electron: tray, windows, lifecycle
  src/server-process.ts the server as a child process, and its restart loop
  src/tray-menu.ts     the menu as data, so the one surface she has is testable
  src/net.ts           which address to put in front of her; never localhost
  src/connect-page.ts  the QR page, the one thing this app renders itself
  src/paths.ts         where the state, the pages and the server live, packaged or not
  src/client.ts        the shell as a client of its own server, so a hotkey is an invoke
  src/hotkeys.ts       which keys a grid claims, and what a key another app owns means
  src/deck-window.ts   the floating deck: where it opens, and the chrome injected into it
  src/preload.ts       one function, so the injected ✕ can reach the shell
  src/prefs.ts         what the shell remembers about this machine, not about her
  src/logs.ts          the log file behind "Open logs folder"
  src/updates.ts       electron-updater, as four states the menu can say
  build.mjs            three esbuild bundles, so the installer ships no node_modules
  electron-builder.config.mjs  packaging, and the root version it takes
packages/shared        types and constants both sides import, including module state
pnpm-workspace.yaml    workspace globs, and the allowBuilds list for postinstall scripts
docs/plan.html         the design doc, local only and untracked
AGENTS.md              how to work in this repo
.github/workflows      ci.yml on every PR, release.yml on every v* tag
```

## Contributions

Closed for now. The repo is public and MIT, so read it, fork it, lift whatever is useful — but
outside pull requests are not being taken while this is still one person building for one
streamer. Issues are welcome if something here is wrong or broken.

That may change once the shape settles. Until it does, what follows is how the people with
commit rights work in it, not an invitation.

Trunk based. `main` is always green and always releasable. Short-lived branches off it, one
concern each, squash merged through a PR with a conventional commit title. Nothing else is
long-lived: unfinished work lands on `main` inert instead, which a game module makes easy since
one that nothing registers ships as dead code.

Releases are one version for the whole product, cut from a tag:

```bash
pnpm release:minor        # bumps the root version, commits, tags
git push --follow-tags    # CI reruns, then a GitHub Release appears
```

`AGENTS.md` has the rest, including what major, minor and patch mean for someone who is not a
developer.

## License

MIT. That is deliberate. Streamer.bot, Mix It Up, SAMMI, and Touch Portal are closed or
source-restricted, and WebDeck is GPL-3.0, so none of them are fork bases. Everything here is
built on verified MIT libraries so the project stays ours.
