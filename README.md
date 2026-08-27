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

Early. Phase 1 of four.

The server is built around the game module contract and runs. Chat events in, module state out,
snapshot-synced over Socket.IO. Two modules ship with it: the challenge wheel and a chat log.

`apps/overlays` has its first page: the wheel overlay, which OBS loads as a browser source at
`overlay.html?module=wheel`. It renders server state and decides nothing.

Next: the control page she drives the stream from, with a mock-chat panel, then the Phase 1
slice end to end.

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
```

The server listens on port 4400 and binds `0.0.0.0`, so a phone on the same Wi-Fi reaches it at
`http://<pc-ip>:4400`. Run `pnpm build` once and it serves the overlay pages too, which is how
she runs it: one address for OBS, her phone and the server.

Pages never assume they were served by the server. The address arrives as `?server=`, falling
back to wherever the page came from, so the same build works with OBS on her PC, her phone on
the LAN, and the server on a VPS the day she streams IRL:

```
http://<server>:4400/overlay.html?module=wheel
http://<pages-host>/overlay.html?module=wheel&server=http://<server>:4400
```

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
  core/obs.ts          OBS seam; a no-op adapter until Phase 2
  chat/                the one platform-specific layer: adapter.ts, youtube.ts, mock.ts
  modules/wheel/       the first game module; rules.ts is pure and testable
  modules/chatlog/     the second, and the proof the contract holds
apps/overlays/
  overlay.html         one browser source per module: ?module=wheel
  src/lib/serverUrl.ts the only thing that decides where the server is
  src/lib/connection.ts one socket, snapshot-on-connect, no game logic
  src/modules/         client half of the module contract, keyed by module id
  test/                Playwright: the two things a socket client cannot check
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
