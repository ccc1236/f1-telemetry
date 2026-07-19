# Roadmap

Working roadmap for this self-hosted fork. Not upstream planning.

## Planned

### Historical race replay from the F1 archive
Download completed sessions so missed races can be watched in the dashboard.

- Build an **archive → replay converter**: fetch a completed session's
  `.jsonStream` files from `livetiming.formula1.com/static/…` and transform
  them into the project's `ReplayFrame` JSON that `replay.ts` already reads.
- Support a **race-only** option (skip FP/Q) — each session is a separate
  archive entry, so filtering to `"Race"` is a one-line filter.
- Size is a non-issue: ~10 MB per race (matches the bundled Suzuka race),
  so all 9 completed 2026 races ≈ ~90 MB.
- Byproduct: yields real per-track mini-sector counts (e.g. Monaco), which
  are otherwise undocumented.

### Smooth the start/finish position gap (cosmetic, low priority)
`NumberOfLaps` increments ~4s before the per-segment reset, so a car's
position is unreported between crossing the line and the reset. The dot
pauses at start/finish then resumes at turn 1. Motion is forward-only
(never backward), so this is a data gap, not a logic bug. Could be
smoothed by interpolating through the window.

## Tracking / upstream

- PR #25 (SignalR Core migration) and PR #27 (track map fixes) are open on
  matteocelani/f1-telemetry, awaiting maintainer review.

## Gotchas

### `record.ts` recordings distort segment data
Recordings are batched at 100ms with a deep-merge, which mashes bursts of
segment updates into states that never occur on the live feed. Validating
the track map against `suzuka-race.json` produced 289 backward dot jumps
and hundreds of mid-lap "collapses" of the completed-segment count; the
same logic against the live feed produced 6 jumps in 910 lap boundaries.
**Validate positioning logic against a live session, not a recording.**
Recordings remain fine for UI/replay work.

## Shipped

- Track map dot positioning: segment-reset lap derivation, array-format
  segments, status 2064, offset-distance wrap.
  - Validated live at Spa qualifying: 17 lap boundaries, 0 backward jumps.
  - Validated over the full 2026 Belgian GP race: 910 lap boundaries,
    6 backward jumps (0.66%), 2 visibly large, through green, yellow,
    Safety Car and VSC, plus pit cycles and 3 retirements.
- Removed hosted-only "service unavailable" banner.
- SignalR Core migration + Bearer auth; Docker self-hosting.
