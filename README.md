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
snapshot-synced over Socket.IO. The wheel, goals, gains, moderation, chat log and media pack all
ship as modules.

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

The tray pairs every control surface. Its phone QR carries a short-lived code, while each declared
overlay gets its own named OBS URL in the tray. Those copied URLs carry a read-only capability
that cannot press buttons or read the moderation queue. The
tray, floating deck and hotkeys bootstrap through a loopback-only route. "Disconnect all devices"
rotates both capabilities when a phone or copied URL should stop working.

The media pack stores up to 24 clips beside her state file. A clip can be previewed, added to the
deck, played through one server-timed lane and stopped explicitly. The library survives a restart;
active playback does not. An overlay that reconnects during a clip seeks to the server's elapsed
time instead of starting the clip again. OBS needs the tray's Media overlay URL once; a wheel
browser source deliberately subscribes only to wheel state.

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

The server listens on port 4400 and binds `0.0.0.0`. Run `pnpm build` once and it serves the
overlay pages too. She opens pages through the tray, which pairs her phone and copies the
read-only overlay URL for OBS. Typing the LAN address alone deliberately does not grant access.

Pages never assume they were served by the server. The address arrives as `?server=`, falling
back to wherever the page came from, so the same build works with OBS on her PC, her phone on
the LAN, and the server on a VPS the day she streams IRL:

```
http://<pages-host>/overlay.html?module=wheel&server=http://<server>:4400&access=<read-token>
http://<pages-host>/control.html?server=http://<server>:4400&pair=<short-code>
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

Mock chat is registered on every run, hers included, so a feature is demonstrable without going
live. It is a `standIn`, which means the moment a real adapter can answer, mock chat stops being
asked -- otherwise a goal bar on her stream renders invented numbers that look entirely
plausible.

She points it at her channel from her phone, because she cannot set an environment variable.
These three are seeds, used only while she has saved nothing, and only worth setting when you
are specifically testing the adapter:

```bash
YT_CHANNEL_ID=UC...   # watches the channel, reconnects when she goes live
YT_LIVE_ID=...        # attaches to one specific broadcast
YT_API_KEY=...        # subscriber and like counts, nothing else
```

Reading chat needs no API key and no OAuth. It goes through `youtube-chat-next`, which reads
what the web page reads. The key is a YouTube Data API key on the public-data path, and it buys
the counts the goal bars fill from: one quota unit a call against 10,000 a day. It is stored in
her state server-side and never sent to a client, which carries `hasKey` and never the key.
Never compile one in: this repo is public and so is the installer.

*Writing* to chat is the other half, and it needs a Google sign-in. She does it from the chat
card on her control page: press Sign in, read the code, type it into Google on whatever device
is nearest. Nothing is typed into a terminal and no redirect has to land anywhere, which is why
it is the device flow rather than a loopback one — the browser may be her phone while the server
is a VPS.

Two things about it are worth knowing before the day they surprise someone:

- **The sign-in lasts seven days while the Google project is in Testing.** That is Google's
  rule, not ours, and it applies to whosever project the credential came from. Until the consent
  screen is verified she re-signs-in weekly; the card says so, and a sign-in that has expired
  offers the button again rather than failing quietly.
- **She can use her own Google project, and should if she has one.** The daily quota belongs to
  whichever project the credential came from, so a credential shipped in the installer is a pool
  every install draws on. Hers is 10,000 units nobody else can spend. Client ID and secret go on
  the same card; the ID is echoed back to her, the secret never is.

A build can carry a credential of its own, substituted at build time from `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` rather than committed. Blank is a supported build and is what this repo
ships: with none, the card asks her for one. It is not a secret either way — it ships inside the
installer — and what it exposes is a shared quota, not her channel. `AGENTS.md` has the full
argument.

## Layout

```
apps/server/src/
  main.ts              composition root; the only file that reads process.env
  core/kernel.ts       wires registry + trigger gate + chat adapters; takes its deps
  core/registry.ts     modules, state slices, event fan-out, enabled/armed lifecycle
  core/triggers.ts     command parsing and the permission/cooldown/price gate
  core/sync.ts         the only file that imports socket.io
  core/store.ts        namespaced slices, atomic debounced writes
  core/access.ts       persistent read/control capabilities and short pairing codes
  core/gains.ts        the channel currency ledger
  core/stats.ts        the counts, polled off the adapters and published as core state
  core/obs.ts          the OBS seam, and the live obs-websocket connection in it
  core/obs-config.ts   OBS's own config file, and the words her card shows
  chat/                the one platform-specific layer: adapter.ts, youtube.ts, mock.ts
  chat/youtube-stats.ts the Data API half: two public reads, and her words for a failure
  modules/wheel/       the first game module; rules.ts is pure and testable
  modules/chatlog/     the second, and the proof the contract holds
  modules/goals/       subscriber, like and counted-by-hand goals; rules.ts is pure
  modules/media/       durable clip library, file store and one playback lane
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
