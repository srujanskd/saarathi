<!--
Title: conventional commit in plain language, e.g. fix(server): superchat spins no longer stack
It becomes a line in the next release notes, so write it for someone reading a changelog.
One concern per PR. If this description says "also", split it.
-->

## Problem

<!-- A sentence or two. What was wrong or missing. -->

## Fix

<!-- How you fixed it. -->

## Surfaces covered

<!-- Delete what does not apply, say what you did for what remains. See "Hit every surface" in AGENTS.md. -->

- [ ] Every trigger for the action (chat, paid, points, deck, control page)
- [ ] Overlay and control page
- [ ] Reconnect and restart
- [ ] Persistence decided explicitly (durable or in-memory — say which)
- [ ] Demoable through mock chat
- [ ] Touch targets
- [ ] Reverse state exists (disarm, cancel)

## Verification

<!-- pnpm test and pnpm typecheck counts. For anything chat-driven, what you saw happen through mock chat. -->
<!-- Overlay changes: before and after image. Animation: a short video. -->

---

Model and harness:
