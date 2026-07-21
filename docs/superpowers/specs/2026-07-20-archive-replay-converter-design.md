# F1 Archive → Replay Converter

Design doc. Status: approved, not yet implemented.

## Goal

Let a self-hosted user watch a completed F1 session in the dashboard. F1 publishes
every finished session to a public static archive; this converts a session from that
archive into the `ReplayFrame[]` JSON that `replay.ts` already plays.

Primary use case: watching races missed during the 2026 season. Secondary: obtaining
per-track data (e.g. mini-sector counts) without waiting for a live session.

## Background

The archive lives at `https://livetiming.formula1.com/static/`. It is public and needs
no auth, unlike the live SignalR Core endpoint.

`{year}/Index.json` lists meetings and sessions. Each session carries a `Path`, plus
`Type`, `Name`, `StartDate`. Per-session, each channel is a `.jsonStream` file whose
lines are a session-relative timestamp immediately followed by JSON:

```
00:00:09.631{"Lines":{"12":{...,"Sectors":[{...},{...},{...}]}}}
```

`SessionInfo.json` is plain JSON, not a stream.

Two facts confirmed by inspection:

- Sprint sessions also have `Type: "Race"`. Distinguishing a Grand Prix from a sprint must
  key off the session `Name`/path, not `Type`. 2026 has 10 Grands Prix and 4 sprints
  (China, Miami, Canada, Britain).
- `Sectors` is already an array in the archive, matching the SignalR Core live format,
  so existing array-handling code applies unchanged.

### Measured sizes (Belgian GP race)

| File | Archive size |
| --- | --- |
| `TimingData.jsonStream` | 5.73 MB |
| `Position.z.jsonStream` | 8.82 MB |
| `CarData.z.jsonStream` | 7.23 MB |
| All other timing/context channels | ~0.4 MB |

A sprint uses the identical file set at roughly 9 MB total. The full 2026 season is
therefore about 220 MB for the 10 Grands Prix and ~37 MB for the 4 sprints.

`Position.z` decompresses at **9.04x** (measured over 896 entries), and its native update
rate is **~1 Hz** (median 1000 ms). Because 1 Hz is slower than a 100 ms frame,
downsampling telemetry saves nothing. Assuming `CarData.z` expands comparably, storing
telemetry decompressed would produce roughly 150 MB per race (~1.5 GB for 10 races);
storing it compressed keeps a race at ~22 MB (~220 MB for 10). The decision holds even if
`CarData.z` expands somewhat differently, since the ratio is an order of magnitude.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Channel scope | All channels, incl. `Position.z` and `CarData.z` | Full dashboard: GPS track map, telemetry charts, timing |
| Pacing | Real time, 100 ms frames, empty frames as padding | `REPLAY_INTERVAL` already provides speed control |
| Telemetry storage | Keep `.z` payloads compressed | 7x smaller and byte-faithful to what F1 published |
| Structure | One-shot CLI writing a JSON file | Mirrors `record.ts`; watchable offline and repeatedly |
| Selection | Name fragment, `--round N`, `--all`, `--list` | Matches existing `pnpm record [file]` ergonomics |
| Sprints | Included, behind `--sprint` / `--sprints` | Identical format and only ~9 MB each; the flag keeps the default unambiguous |

## Architecture

Three modules, following the existing `@services/*` layout.

| File | Purpose | Depends on |
| --- | --- | --- |
| `src/archive.ts` | CLI: arg parsing, orchestration, atomic write | client, converter |
| `src/services/archive-client.ts` | Network only: fetch index, resolve session, GET channel files | `fetch` |
| `src/services/archive-converter.ts` | Pure: parse streams, bucket into frames | none |

The converter is pure — no network, no filesystem. It holds the real logic (timestamp
parsing, bucketing, collision rules) and is testable against small fixtures without
downloading a race.

Output is format-compatible with `record.ts`, so existing tooling keeps working:

```
pnpm archive monaco → apps/backend/data/2026-06-07_monaco_race.json
pnpm dev:replay apps/backend/data/2026-06-07_monaco_race.json
```

## Conversion algorithm

1. **Resolve** the session: fetch `{year}/Index.json`, filter to Grands Prix (plus sprints
   when requested), match by name fragment or round, yield the session `Path`.
2. **Fetch** each channel file under that path. `SessionInfo.json` is fetched as plain JSON.
3. **Parse** each line with `^(\d{2}):(\d{2}):(\d{2})\.(\d{3})(.*)$` into `{ tMs, payload }`.
   Strip the BOM; tolerate `\r\n`.
4. **Bucket** into 100 ms bins: `frameIndex = floor(tMs / 100)`.
5. **Resolve collisions**. Exactly two rules, split by channel:
   - **Every channel except `Position.z` and `CarData.z`** is **never merged**. If a
     channel already occupies a frame, the entry spills to the next frame free for that
     channel, preserving every discrete update and its order.
   - **`Position.z` and `CarData.z`** use last-wins within a frame, which at their ~1 Hz
     native rate effectively never triggers.
6. **Prepend** one synthetic `snapshot: true` frame carrying `SessionInfo`, so each
   replay loop begins with a clean `replaceState`.
7. **Pad** quiet bins with `{ updates: {} }` to hold real-time pacing (~16 bytes each;
   ~54,000 frames for a 90-minute race, under 1 MB total).
8. **Write** atomically (tmp file, then rename).

### Why timing channels are never merged

`record.ts` batches on a 100 ms interval and deep-merges within the window. Validating
the track map against `suzuka-race.json` produced 289 backward dot jumps and hundreds of
phantom mid-lap collapses of the completed-segment count. The same logic against the live
feed produced 6 jumps across 910 lap boundaries. The merge fuses bursts of segment deltas
into intermediate states that never occur on the wire. This converter must not repeat that,
hence the spill-to-next-frame rule.

## Channel mapping

Channel names must match `CHANNELS` in `@f1-telemetry/core` exactly, because the frontend
`wsHandler` switches on those literals.

| Archive file | Replay channel |
| --- | --- |
| `TimingData.jsonStream` | `TimingData` |
| `TimingAppData.jsonStream` | `TimingAppData` |
| `TimingStats.jsonStream` | `TimingStats` |
| `TrackStatus.jsonStream` | `TrackStatus` |
| `RaceControlMessages.jsonStream` | `RaceControlMessages` |
| `WeatherData.jsonStream` | `WeatherData` |
| `DriverList.jsonStream` | `DriverList` |
| `SessionData.jsonStream` | `SessionData` |
| `LapCount.jsonStream` | `LapCount` |
| `ExtrapolatedClock.jsonStream` | `ExtrapolatedClock` |
| `Position.z.jsonStream` | `Position.z` |
| `CarData.z.jsonStream` | `CarData.z` |
| `SessionInfo.json` | `SessionInfo` |

The `.z` suffix is **retained**. `CHANNELS.POSITION` is `'Position.z'` and
`CHANNELS.TELEMETRY` is `'CarData.z'`; the frontend matches those literals, and the live
backend broadcasts them unchanged.

## Companion changes

Two small changes outside the converter, both in scope.

### 1. Fix `.z` stripping in `record.ts`

`resolveChannel` does `channelName.slice(0, -2)`, emitting `CarData` and `Position`. The
frontend switches on `CarData.z` and `Position.z`, so those channels never match and every
recording silently loses telemetry and GPS in replay. This is why replay falls back to
segment mode on the track map. Retain the suffix; the comment claiming otherwise is wrong.

### 2. Decompress `.z` payloads in `replay.ts`

Because the converter stores telemetry compressed, replay must decompress before
broadcasting. For any channel ending in `.z`: if the payload is a `string`, decompress via
`decompressPayload`; if it is already an object, pass it through. The type check keeps
existing decompressed recordings working unchanged.

## CLI

```
pnpm archive --list             # list completed sessions for the season
pnpm archive monaco             # match by name fragment, case-insensitive
pnpm archive --round 6          # match by round number
pnpm archive chinese --sprint   # that weekend's sprint instead of the Grand Prix
pnpm archive --all              # all 10 Grands Prix, sequentially
pnpm archive --all --sprints    # all 14 sessions (Grands Prix + sprints)
pnpm archive monaco --out DIR   # override output directory
```

Default output directory is `apps/backend/data/`. Filenames are
`{date}_{meeting-slug}_{session}.json`, where `{session}` is `race` or `sprint` — for
example `2026-06-07_monaco_race.json` and `2026-03-14_chinese_sprint.json`.

Selection defaults to the Grand Prix. On the four sprint weekends both sessions exist, so
`--sprint` selects the sprint for a single-session match, and `--sprints` widens `--all`
to include them. Making sprints opt-in keeps a bare name match unambiguous.

## Error handling

| Failure | Behaviour |
| --- | --- |
| Index or required channel unreachable | `throw new Error(msg, { cause: err })`; abort that race, write nothing |
| Optional channel returns 404 | `Logger.warn`, continue with an empty stream |
| Malformed `.jsonStream` line | Skip it, tally it, report the count on completion |
| One race fails under `--all` | Continue, collect failures, print a summary, exit non-zero |
| Crash mid-write | Atomic tmp-then-rename; never leaves corrupt JSON |

`TimingData` and `SessionInfo` are required; all other channels are optional. Because
telemetry is stored compressed, no decompression occurs during conversion, removing that
error class from the converter entirely.

## Validation

Three layers, no new dependencies. Node v24 runs `node:test` and `node:assert` natively
and executes TypeScript directly, so tests need no packages added.

1. **Unit tests on the pure converter**: timestamp parsing (BOM, `\r\n`), bucketing,
   the spill-on-collision rule, snapshot prepending, padding.
2. **Golden validation against a known live capture**: convert the Belgian GP race and run
   it through the same harness used on the live feed, which recorded 910 lap resets, 6
   backward jumps, and a green → yellow → SC → VSC sequence. Comparable numbers demonstrate
   the converter is faithful to what the live feed delivered.
3. **Replay smoke test**: run `dev:replay` against converted Monaco and confirm the
   dashboard renders GPS dots, telemetry, and the timing tower.

## Out of scope

- Seek, pause, and scrub. `replay.ts` plays frames on a fixed tick and loops forever;
  changing that is a separate concern.
- Practice and qualifying sessions. The fetcher is session-agnostic, but selection targets
  Grands Prix and sprints only.
- Trimming dead air such as pre-race waiting or red-flag stoppages.
