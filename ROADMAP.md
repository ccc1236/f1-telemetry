# Roadmap

Working roadmap for this self-hosted fork. Not upstream planning.

## Planned

### Trim the pre-race build-up (`--from-race-start`)
Real-time pacing is faithful but includes everything the feed carried. Converted
Monaco is 124,858 frames — **208 minutes** — and racing does not begin until frame
34,024, **56.7 minutes in**. Nearly an hour of build-up before lights out.

Add a `--from-race-start` flag to `pnpm archive` that slices the timeline shortly
before the race begins:

- Detect the start via `LapCount.CurrentLap >= 2` (first completed racing lap).
- Slice with a configurable lead-in, default ~120s, to catch the grid and start.
- **Fold every skipped frame into a single snapshot frame.** A naive slice discards
  accumulated state (`DriverList`, `SessionInfo`, stints) and the dashboard renders
  empty rows.
- **Reuse `@utils/deepMerge`.** A hand-rolled merge that combines arrays
  element-wise fuses unrelated entries (`Messages`, `Series`, `Stints`, `Segments`)
  into corrupted hybrids and crashes the frontend with a client-side exception.
  The project's version replaces arrays wholesale and handles F1's sparse
  numeric-key patches.

A working prototype lives in the session scratchpad (`trim-replay.mjs`); Monaco
trims from 124,858 to 92,035 frames (208 → 153 min) and boots correctly.

Workaround today: `REPLAY_INTERVAL=25 pnpm dev:replay <file>` for 4x speed.

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

- **Historical race replay from the F1 archive.** `pnpm archive <name|--round N|--all>`
  converts a completed session from `livetiming.formula1.com/static` into
  `ReplayFrame` JSON that `replay.ts` plays. `--list` shows the season; sprints are
  available behind `--sprint`/`--sprints`.
  - Telemetry is stored still-compressed and inflated by `replay.ts`, keeping a race
    at ~20 MB instead of ~150 MB. Monaco converts in 15s to 19.7 MB.
  - Rounds are derived chronologically because the feed's `Number` field is
    duplicated and out of order (it reports 6 for both Miami and Monaco).
  - The archive answers **403**, not 404, for files that were never published.
  - Validated against the Belgian GP live capture: 28 segments (exact), 952 lap
    resets vs 910 live, and 2 visually-large backward jumps — matching live exactly.
    The archive covers the full session, so its slightly higher counts are expected.
  - Mini-sector counts, previously undocumented: **Monaco 22** (6+10+6),
    **Spa 28** (8+12+8). They do not scale with track length.

- Track map dot positioning: segment-reset lap derivation, array-format
  segments, status 2064, offset-distance wrap.
  - Validated live at Spa qualifying: 17 lap boundaries, 0 backward jumps.
  - Validated over the full 2026 Belgian GP race: 910 lap boundaries,
    6 backward jumps (0.66%), 2 visibly large, through green, yellow,
    Safety Car and VSC, plus pit cycles and 3 retirements.
- Removed hosted-only "service unavailable" banner.
- SignalR Core migration + Bearer auth; Docker self-hosting.
