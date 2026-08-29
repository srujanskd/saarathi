# Saarathi

Saarathi is a set of stream tools for one fitness streamer on YouTube. A Node server reads her
live chat and drives OBS. React pages render overlays into OBS browser sources and give her a
phone-friendly control page. It ships as an Electron tray app on Windows.

Read `docs/plan.html` before you make design decisions. It has the full architecture, the
licensing research behind every dependency, and the four-phase roadmap. It is gitignored on
purpose, so it may be missing from a fresh clone. If it is not there, ask for it rather than
guessing at the design. This file is about working in the code.

## The four things we cannot get wrong

Everything else is negotiable. These are not.

### 1. She never opens a terminal

The person using this is not technical and is on Windows. If a feature needs a command, an env
var she has to set by hand, or a config file she has to edit, the feature is not done. It ships
as a tray icon, an installer, and a web page with buttons on it.

That also means failures have to be legible. "No live stream found, retrying every 60s" is a
useful status. A stack trace in a console she will never look at is not.

### 2. Nothing knows where it is running

She wants to stream IRL from an Android phone later, which means the server may move to a VPS.
So: overlays take the server address as a URL parameter, control pages are installable PWAs
with touch targets big enough for sweaty fingers, and no code anywhere hardcodes `localhost`.
Her phone is a first-class client, both as a remote control and as a sensor (heart rate over
Web Bluetooth, GPS).

If your change works when you open it on the dev machine and breaks when the phone loads it
over the LAN, it is broken.

### 3. Games are plugins

Every interactive game implements one module contract. It declares the chat commands it claims
and the events it wants, receives core services (event bus, points ledger, persisted state
slice, timers, alerts, OBS actions, bot replies), and exposes an overlay route, a control card,
and deck actions. The core owns the lifecycle: install, configure, arm, running, resolved.

The wheel is the first module, not a special case. When you find yourself adding a wheel-shaped
hook to the core, you have found a gap in the contract instead. Fix the contract.

### 4. The chat layer is the only platform-specific part

YouTube today, maybe Twitch later if she multistreams. Adapters normalize everything into
`chat-command`, `paid-event`, and `new-member`. Nothing downstream of the adapter should ever
mention YouTube. Free commands, gains, and off-platform tips all arrive as the same events, so
Super Chats slot in with no rework when she gets monetized.

## How I like to work

Ambitious ideas, simple systems. Do not keep complexity because it is already there, and do not
add machinery because it looks impressive. Find the real constraint, then write the smallest
thing that makes the correct behavior boring.

Measure twice, cut once, and also YAGNI. Fight scope creep. If you think the task is wrong, say
so before you build it, not after.

Treat this file as good defaults, not law. My preferences in the moment beat anything written
here. If a rule fights the task in front of you, say so out loud and get a decision.

## Glossary

- **you** is the agent reading this and changing Saarathi.
- **I** and **we** are the maintainer, the person you are talking to now.
- **she** and **the streamer** are the one person this software is for. She is not a developer.
- **chat** is her viewers. They send commands and spend points.
- **module** is one game plugged into the core through the game module contract.
- **adapter** is the platform-specific chat layer, currently YouTube, plus mock for testing.
- **overlay** is a page OBS loads as a browser source. It renders, it never decides.
- **control page** is the page she drives the stream from, usually on her phone.
- **deck** is the configurable action grid, rendered three ways: touch PWA, global hotkeys,
  floating always-on-top window.
- **gains** are the self-hosted channel currency, since YouTube has no channel points. Chat
  earns them per active minute and spends them on spins (`!spend 500 spin`). The name is not
  final, so keep it in one constant and out of a hundred string literals.
- **studio mode** is streaming from her PC at home. **IRL mode** is streaming from her phone.

## Three ways to hurt yourself

1. **Killing processes by pattern.** Never `pkill -f`, never `kill` a PID you found by matching
   a path or a name. This machine runs other things, and your own process has this repo's path
   in its argv. Kill a PID you captured when you spawned it, nothing else.

2. **Writing to live state.** `data/state.json` holds her real challenge list and spin history.
   Reading it is fine and it makes good test data. Do not point a dev server at it, do not
   rewrite it, do not clean it up. Set `STATE_FILE` to somewhere in your scratch space instead.

3. **Baking in an origin.** The moment a `localhost:4400` string lands in an overlay, a control
   page, or a QR code, IRL mode is dead and nobody notices until the day she is outside. Server
   address comes from a URL parameter or from where the page was served, always.

## Hit every surface

The most common defect here is a change that works on the one path you tested. Before you call
frontend work done, walk this list and say which parts applied:

- **Every trigger for the same action.** A spin can come from `!spin` in chat, a paid event, a
  points spend, a deck button, and the control page. Fixing one path is not fixing the feature.
- **Overlay and control page both.** They render the same server state and both have to survive
  a reconnect.
- **Reconnect and restart.** Her phone sleeps, Wi-Fi drops, OBS reloads a browser source
  mid-stream. The server is authoritative and sends a full snapshot on connect. If your feature
  only works when a client was present for the event that started it, it is broken.
- **Persistence.** Decide explicitly whether new state survives a restart. Durable data goes
  through the store, transient data stays in memory. Say which one you picked.
- **Mock chat.** Every chat-driven feature has to be testable through the mock path without a
  live stream. If you cannot demo it with mock chat, nobody can test it.
- **Touch.** Anything she touches mid-workout is a big target on a phone screen, reachable with
  one hand, and readable at arm's length.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Arm needs
  disarm. Start needs cancel. A one-way door is a bug.

## Running it

```bash
pnpm install
pnpm dev             # server + overlays
pnpm typecheck
pnpm lint            # eslint, warnings included
pnpm lint:fix        # the same, applying what it can fix on its own
```

The tray app is its own workspace and its own loop:

```bash
pnpm --filter @saarathi/desktop dev   # bundles, then runs the tray against this checkout
pnpm dist                             # the Windows installer, buildable from any platform
```

It starts the server as a child process rather than importing it, so a server crash shows up in
a menu instead of taking the tray down, and it hands the child four env vars — `STATE_FILE`,
`OVERLAYS_DIST`, `PORT`, `LOG_LEVEL`. Those four are the entire contract between the shell and
the server; `spawnPlan` is where they live and `test/unit/server-process.test.ts` is what breaks
when one is renamed. Nothing about a game module belongs in `apps/desktop`.

For the same reason it does not import the server, it does not import the kernel either: a
global hotkey reaches an action by opening a socket to `127.0.0.1` and calling `invoke`, exactly
as her deck page does over the LAN. There is one code path into an action and there is not going
to be a second. A hotkey is a value on a `DeckSlot`, picked from the closed list in `HOTKEYS` —
never a string anyone types, because `globalShortcut.register` throws on one it cannot parse and
because she arranges her grid on a phone, which cannot offer "press the combination you want".
The floating deck window loads the same `deck.html` everything else does; its frame, its drag
strip and its close button are injected by the shell, so the page stays one page.

Server is on 4400, bound to `0.0.0.0` so the phone can reach it. Develop against mock chat.
Only set `YT_CHANNEL_ID` or `YT_LIVE_ID` when you are specifically testing the adapter, and
never while she is live.

OBS control needs its WebSocket server switched on once, in OBS under Tools → WebSocket Server
Settings. Nothing else: the server reads the port and the generated password out of OBS's own
config file, so neither you nor she ever types one. `OBS_CONFIG` overrides that path, and blank
switches autodetect off entirely — which is what the e2e suite forces, so no test run ever finds
the real OBS on the machine running it.

Package manager is pnpm, pinned in `packageManager`. Use it, not npm: an `npm install` here
writes a `package-lock.json` and a flat `node_modules` that hides missing dependencies. Add
packages with `pnpm add -F @saarathi/server <pkg>`, and depend on workspace packages with
`workspace:*`. A dependency with a postinstall script needs an entry under `allowBuilds` in
`pnpm-workspace.yaml` before its build runs.

## Testing

```bash
pnpm test            # unit + unit-overlays + integration + e2e, about 30s
pnpm test:fast       # skip e2e, for the tight loop -- under a second
pnpm test:watch      # same, watching
pnpm test:unit
pnpm test:integration
pnpm test:e2e
```

Vitest, configured once in `vitest.config.ts` at the root as five projects, split by what a test
needs rather than by what it covers. Three of them live in `apps/server/test`:

- **unit** pure functions only: spin rules, the command gate, gains, the store, adapter
  normalization. No clock, no kernel, no port.
- **integration** a real `Kernel` over a `MemoryStore` and mock chat, in process. Fake timers are
  fine here. This is where you prove a chat command reaches an action, a paid spin queues and
  drains, and a refusal gives back the gains it charged.
- **e2e** the real server as a child process on a port the OS handed us, driven by a real
  `socket.io-client`. This is the only layer that proves reconnect, per-module subscription and
  restart-persistence, because those are the bugs that only show up over a socket.

The other two are the same tier in the other two workspaces. In `apps/overlays/test/unit`:

- **unit-overlays** the same tier as **unit**, in the other workspace. It is a separate project
  only because a Vitest project has one root. Pure functions from the overlay app: wheel
  geometry, the label budget, the wedge palette. No DOM, no React, no socket. Anything that
  needs a browser is a `.spec.ts` and Playwright runs it.

And in `apps/desktop/test/unit`:

- **unit-desktop** pure functions from the tray app: which LAN address to show her, what the
  menu says in each state, how the server child is spawned, where its state and pages live,
  which keys a grid claims and when a change to it is a change to the keys, and where the
  floating window opens when the monitor it remembers is gone.
  Electron is the one thing in this repo nothing can boot, so `main.ts` holds no decisions and
  this project holds all of them. If you find yourself wanting to test `main.ts`, the thing you
  want to test is in the wrong file.

Helpers you should use instead of rolling your own:

- `test/helpers/kernel.ts` — `harness()` gives you a started kernel with a memory store, a fake
  OBS and mock chat. Pass `store` to boot twice on the same state and prove a restart.
- `test/helpers/collect.ts` — `collect(kernel)` taps patches and effects, which is exactly what a
  client receives and nothing more.
- `test/e2e/helpers/server.ts` — `startServer()` boots the real thing with `STATE_FILE` in a temp
  directory. It kills only the PID it spawned, and it never touches `data/`. Pass
  `stop({ keepState: true })` when a second run needs the same file.

Not a test helper, but it is what CI runs beside them: `apps/desktop/build.mjs` produces the
three bundles the installer ships, and CI builds it on every push, because a bundle that stopped
bundling would otherwise surface on a tag with nowhere to fix forward from.

Rules for this suite:

- Never point a test at `data/state.json`. `startServer` and `harness` both make their own.
- E2E kills the child by the PID it spawned. Do not add a pattern kill. See rule 1 above.
- Nothing waits on a sleep. Poll a predicate (`waitFor`) or advance fake timers.
- A new chat-driven feature needs an integration test through mock chat, or it is untestable by
  anyone but you.

The browser layer is Playwright, in `apps/overlays/test`, run separately:

```bash
pnpm test:browser    # builds the pages, then drives Chromium against a real server
```

It is separate from `pnpm test` on purpose. It needs a browser downloaded
(`pnpm --filter @saarathi/overlays exec playwright install chromium`), it takes about fifteen
seconds, and nothing in it belongs in the tight loop. CI runs it on Ubuntu only: these specs are
about what CEF does with a transform, not about what Windows does with a child process, and the
matrix already covers the latter.

Playwright is Apache-2.0, not MIT. It is a devDependency and nothing it touches ships to her,
which is the only reason the exception holds. Do not let it creep into a runtime dependency.

Keep this layer to what a socket client genuinely cannot reach:

- a page takes the server address from `?server=` rather than the origin it was served from
- a spin animates `transform` and `opacity` only, and leaves nothing on the browser's animation
  books once it lands
- an overlay opened mid-spin joins the spin already in progress

Everything else about a feature is cheaper and steadier to prove in the server's own three
projects. If a browser spec you are about to write would pass with the browser replaced by a
socket, write it there instead.

Mutate before you trust a browser spec. Break the thing on purpose, watch it fail, put it back.
The first version of the animation spec here passed against a wheel that never turned, because a
fade on the container satisfied "something is animating".

"Nothing waits on a sleep" holds here too, with one carve-out: a spec may wait deliberately when
elapsed wall-clock time is the thing under test, because there is no predicate to poll for "two
seconds have passed". Never wait for a state change that way, and never assert against the wait
constant -- ask the server how far along it thinks it is, or the spec goes vacuous the day
somebody tunes the number.

Stop the servers you started, by the PID you tracked. See rule 1.

## Verifying

Smallest proof that the change works. Typecheck the workspace you touched. For anything driven
by chat, drive it through mock chat and say what you saw happen.

Spin rules, points math, cooldowns, and adapter normalization are where the real bugs live, and
they all have tests now. Add to them rather than writing a one-off script.

Run `pnpm test`, `pnpm typecheck` and `pnpm lint` before you say a change works, and say what
the counts were.

Do not open a browser or use computer use to verify unless I ask for it.

## Where code lives

- `apps/server` is Fastify, Socket.IO, chat adapters, the game modules, OBS control, and JSON
  persistence. This is where decisions happen.
- `apps/overlays` is React and Vite: overlay routes for OBS, control pages for her phone.
  It renders state and sends intents, it does not decide anything.
- `packages/shared` holds the types and constants both sides import, including the socket event
  contracts. Change a type here and both ends follow. No runtime logic.
- `docs/plan.html` is the design doc, local only and untracked. Update it when a decision
  changes, so the next agent reads current facts instead of stale intentions.

## Taste

- Platform weirdness stays in the adapter. The core sees normalized events only.
- The server is authoritative. Clients render and send intents. No client-side game logic.
- Inferred types over annotations. `any` is the enemy, and `no-explicit-any` is an error, so
  the two places it is tolerated are named in `eslint.config.js` and in the code itself:
  `chat/youtube.ts`, where an untyped library is converted at the boundary, and the `S = any`
  default on `GameModuleDef`, which is what lets the core hold every module in one list.
  Adding a third means normalizing at a boundary instead.
- Comments explain why a rule exists, not what the line does. The spin rules comment in
  `wheel.ts` is the shape I want.
- Overlays run inside OBS at 60fps while she is streaming. Animate `transform` and `opacity`
  and nothing else. No continuously repainting animation, ever.
- Socket payloads are small. She may be on phone data in IRL mode.
- Every timestamp in the state is server time. A client corrects for its own clock using
  `Snapshot.serverNow` and never subtracts `Date.now()` from a server timestamp directly: the
  server may be a VPS while the page is on her phone, and a phone's clock is routinely tens of
  seconds out. This is rule 3 again, in the time dimension.
- MIT dependencies only. Check the license before you add anything. This is why we are not
  forking WebDeck and why GSAP is out.

## Plans and work artifacts

Do not commit implementation plans, research notes, or scratch files. Keep working material
outside the repo. Design decisions go in `docs/plan.html`.

Because that file is untracked, anything a contributor genuinely needs has to land in this file
or the README instead. When a decision in the plan starts constraining day-to-day code, promote
the one-line version of it here.

## Branching

One long-lived branch, `main`. It is always green and always releasable, because it is what a
tag gets cut from and there is nowhere else to cut from.

Work happens on short-lived branches off `main`, one concern each, alive for hours rather than
days. Rebase on `main`, open a PR, squash merge. The PR title is the commit that lands, which
is why it has to be a conventional commit in plain language: those titles are the release notes
nobody has to write.

There is no `develop`, no long-lived feature branch, no release branch. Unfinished work goes
onto `main` inert rather than sitting on a branch that drifts. This repo already has the
mechanism for that: a module nothing registers in `main.ts` ships as dead code and costs
nothing, so half a game module can land, be tested, and stay invisible until the line that
registers it is the last commit of the feature.

Direct pushes to `main` are for me, for typos and docs. Anything an agent writes goes through a
PR so CI runs on it before it is trunk.

When something breaks on `main`, fix forward: another PR, or `git revert` of the merge. Do not
open a hotfix branch to repair `main`.

The one exception, and the only branch allowed to outlive a day: she is on v0.4.0, `main` has
moved on to things that are not ready, and she needs one fix now. Then branch `release/v0.4`
from the tag, cherry-pick the fix that is already on `main`, tag `v0.4.1` from it, and let the
branch die. Fix on the trunk first, always, or the next release loses it again.

### Branch protection on `main`

Set once on the GitHub repo, because the strategy is a rule only if the server enforces it:

- require the `verify` checks and `lint` to pass before merge
- require linear history (squash merges only)
- no force pushes, no deletions

## Releases

The whole product is one version. She installs one thing, so `package.json` at the root is the
only version that means anything; the workspace packages are private and their versions are
noise. SemVer, and the audience for it is her, not a dependency resolver:

- **major** — she has to do something. Reinstall, re-point OBS, redo a setting.
- **minor** — something new she can see.
- **patch** — fixes she does not have to know about.

Cut a release when there is something worth her updating for, not on every merge.

```bash
pnpm release:minor          # bumps package.json, commits, tags v0.2.0
git push --follow-tags
```

The tag is the trigger and nothing else decides a version. `release.yml` reruns the full CI
matrix against the tagged commit, refuses a tag that is not an ancestor of `main`, refuses a
tag whose version disagrees with `package.json`, then opens a GitHub Release with notes
generated from the PR titles since the last one.

A tag with a hyphen — `v0.3.0-rc.1` — is marked a pre-release. It exists so something can be
installed deliberately for testing and never handed to her.

`release.yml` has one more job after that one: a Windows runner builds the NSIS installer and
uploads it plus `latest.yml` onto the same release, which is what `electron-updater` polls. It
runs after the release exists, because it uploads onto it. The installer's version is read from
the root `package.json` rather than from `apps/desktop`, so the check above covers it too.

A tag with no installer on it is a tag she cannot install, so if that job fails, fix forward and
cut the next patch rather than editing the release by hand.

## Pull requests

- Never open a PR unless I ask.
- Conventional commit titles in plain language: `fix(server): superchat spins no longer stack`.
  The title is what lands on `main` and what the release notes quote.
- Body is the problem in a sentence or two, then how you fixed it. End with the model and
  harness that did the work.
- Overlay changes need a before and after image. Animation needs a short video.
- One concern per PR. If the description says "also", split it.

## CI

`.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test` on every PR and every push to
`main`, on Ubuntu and on Windows. Windows is not paranoia: she runs there, and the e2e layer
spawns a real child process and writes real temp files, which is exactly where the two
platforms disagree.

`pnpm lint` is its own Ubuntu-only job, because lint reads the source and the source is the
same on both. It runs with `--max-warnings 0`: a rule is either worth failing a build over or
it is not configured, and a warning nobody has to fix is a rule that rots. The config is one
flat file at the root and deliberately not type-aware -- the rules that earn their keep here
are syntactic, and tying lint to three tsconfigs would make it slow enough that nobody runs it
locally. `pnpm typecheck` already reads the types.
