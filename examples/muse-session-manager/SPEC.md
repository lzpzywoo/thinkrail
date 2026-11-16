---
id: module-muse-session-manager
type: module-design
status: active
title: Muse standalone ThinkRail session bridge
parent: architecture
depends-on: [module-contracts]
---

## Responsibility

Standalone Bun/TypeScript bridge registering ThinkRail-branded metadata and keywords with Muse Local Agent Hub. Real queries use the public ThinkRail WebSocket contract. The demo step executor is an explicitly separate source and cannot control real ThinkRail sessions.

## Boundary

Public surface is index.ts. Allowed dependencies are Node/Bun APIs and the contracts barrel; no server internals, Pi runtime, transcript parsing, process discovery, or filesystem activity heuristics. No changes to Muse's intent matcher are owned here.

Real status comes from session.stateList, including needsInput and backgroundWork; TODO completion is plan progress, never an estimated Agent percentage. Empty plans have null percentage. Query failures remain errors, never fabricated empty inventories. Session names must be unambiguous; IDs are preferred. Recent ordering uses workspace lastActiveAt and is explicitly workspace activity ordering.

Snapshots read project/workspace catalogs and the selected sessions' todo.list plans. Snapshot connections use unique client IDs, request deadlines, response acknowledgements, protocol-version validation, and close in finally. Polls never overlap; disconnect resets the observer baseline so historical completions are not announced on reconnect. Observed real-session changes use generic proactive events, never lifecycle frames for tasks the bridge does not own. Notifications are local and best effort; they are not cloud conversation results. A poll observes at most the latest 100 sessions. No full transcript, paths, diffs, or task notes are sent.

Existing create/cancel tools act only on in-memory demo sessions. Actual ThinkRail creation/cancellation is outside this read-only integration. Hub registration identity changes to thinkrail.session-manager; old registrations must be stopped by their owner rather than silently deleted.
