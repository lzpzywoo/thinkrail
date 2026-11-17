---
id: submodule-server-muse
type: submodule-design
status: draft
title: Muse Local Agent Hub companion daemon
parent: module-server
depends-on: [module-contracts]
---

## Responsibility

In-process companion daemon bridging ThinkRail's local server instance to the Muse Local Agent Hub (`http://127.0.0.1:19840`). It registers ThinkRail capabilities and `muse-software/1` dynamic exploration endpoints with Muse Pet (Luna) so that desktop or mobile companions can discover, query, and monitor live ThinkRail projects, workspaces, sessions, and plan execution state.

## Boundary

Public surface is `index.ts`. Exposes `startMuseCompanion`, `MuseCompanion`, `MuseCompanionConfig`, `ThinkRailSessionReader`, and `createThinkRailExploration`.

Allowed dependencies: `@thinkrail/contracts`, `../log`, `@thinkrail/shared`, Node/Bun builtins (`crypto`, `events`, `url`). No UI dependencies, no browser code, and no private server internals outside logging.

## Lifecycle & Fault Tolerance

- When booted by `host/boot.ts`, the companion binds to the assigned local ThinkRail WebSocket URL (`ws://127.0.0.1:${port}/ws`).
- If Muse Local Agent Hub is not running on `127.0.0.1:19840`, the companion logs at `debug` level and schedules periodic retry without throwing unhandled exceptions, blocking `bootHost`, or crashing the ThinkRail process.
- When Muse Pet launches later, the retry loop automatically completes registration and connects to the WebSocket event bus.
- When ThinkRail shuts down (`server.shutdown()` or `server.stop()`), the companion stops its polling observer, cancels retry timers, and cleanly closes the Hub WebSocket connection.
- All errors are reported through `logger("muse")`, never unhandled console errors.
