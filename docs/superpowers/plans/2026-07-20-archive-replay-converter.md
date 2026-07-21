# F1 Archive Replay Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert completed F1 sessions from the public static archive into `ReplayFrame` JSON so races missed during the season can be watched in the self-hosted dashboard.

**Architecture:** Two pure modules (index selection, stream conversion) with zero imports so they unit-test directly under `node --test`; one network client; one CLI entry point. Telemetry stays compressed in the output file and is decompressed by `replay.ts` at playback, keeping a race at ~22 MB instead of ~150 MB. Two companion fixes repair `.z` channel naming so telemetry and GPS actually reach the frontend.

**Tech Stack:** TypeScript, Node 24 (native `node:test` and type stripping — no new dependencies), existing `zlib`/`ws`, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-20-archive-replay-converter-design.md`

---

## Background the engineer needs

**The archive.** `https://livetiming.formula1.com/static/` is public and needs no auth. `{year}/Index.json` lists meetings and sessions. Each session folder holds one `.jsonStream` per channel, where every line is a session-relative timestamp immediately followed by JSON, with no separator:

```
00:00:09.631{"Lines":{"12":{...}}}
```

`SessionInfo.json` is plain JSON, not a stream. All requests should send `User-Agent: BestHTTP`, matching what the rest of the codebase does.

**Three traps discovered while designing this — do not rediscover them the hard way:**

1. **Sprint sessions also have `Type: "Race"`.** Distinguish on the session `Name` field (`"Race"` vs `"Sprint"`), never on `Type`.

2. **The meeting `Number` field is wrong.** In the 2026 index, Miami reports `6` (should be 4) and Monaco also reports `6` — a duplicate. Round numbers **must be derived** by sorting meetings chronologically, not read from `Number`.

3. **Never deep-merge timing channels into a frame.** `record.ts` batches on 100 ms and deep-merges; validating the track map against `suzuka-race.json` produced 289 phantom backward dot jumps, while the same logic on the live feed produced 6 across 910 lap boundaries. Merging fuses bursts of segment deltas into states that never occur on the wire. Discrete channels spill to the next free frame instead.

**Testing.** Node v24.13.1 runs `node:test` and TypeScript natively — no packages to install. Two constraints follow:

- Test files import the module under test **with an explicit `.ts` extension** (`./archive-converter.ts`). Node requires it.
- Because `tsc` (module `Node16`) rejects `.ts` extensions in imports, test files **must be excluded from `tsconfig.json`**. Task 3 does this.
- Every test run prints a `MODULE_TYPELESS_PACKAGE_JSON` warning because the backend package is CommonJS. **This is expected and harmless** — the run still exits 0.

---

## File Structure

| File | Responsibility | Imports |
| --- | --- | --- |
| `apps/backend/src/services/archive-index.ts` | **Pure.** Parse season index, derive rounds, slugify, select sessions. | none |
| `apps/backend/src/services/archive-index.test.ts` | Unit tests for the above. | `node:test` |
| `apps/backend/src/services/archive-converter.ts` | **Pure.** Parse `.jsonStream` text, bucket entries into frames. | none |
| `apps/backend/src/services/archive-converter.test.ts` | Unit tests for the above. | `node:test` |
| `apps/backend/src/services/archive-client.ts` | Network only: fetch index and channel files. | `@utils/logger` |
| `apps/backend/src/archive.ts` | CLI: arg parsing, orchestration, atomic write. | all of the above |
| `apps/backend/src/record.ts` | *Modify:* stop stripping `.z`. | — |
| `apps/backend/src/replay.ts` | *Modify:* decompress `.z` strings, alias legacy names. | — |
| `apps/backend/tsconfig.json` | *Modify:* exclude test files. | — |
| `apps/backend/package.json` | *Modify:* add `test` and `archive` scripts. | — |

The two pure modules hold all the real logic and have **zero imports**, which is what makes them testable without path-alias resolution. Keep them that way: they return diagnostics (counts) rather than logging.

**Deviation from the spec:** the spec listed three modules, with session resolution living inside `archive-client.ts`. This plan splits that resolution into a fourth module, `archive-index.ts`. The reason is testability — round derivation, name matching and slugging are exactly the fiddly logic worth unit-testing, and they cannot be tested if they sit behind `fetch`. The client is left as a thin network layer.

---

## Task 1: Stop stripping `.z` from channel names in `record.ts`

The frontend `wsHandler` switches on `CHANNELS.TELEMETRY` (`'CarData.z'`) and `CHANNELS.POSITION` (`'Position.z'`). `record.ts` strips the suffix, so every recording emits `CarData`/`Position`, which never match — telemetry and GPS are silently discarded on replay.

**Files:**
- Modify: `apps/backend/src/record.ts:268-283`

- [ ] **Step 1: Replace `resolveChannel`**

Find this function:

```typescript
// Decompresses .z channels and strips the .z suffix so the output matches
// the channel names the frontend expects (e.g. "CarData" not "CarData.z").
function resolveChannel(
  channelName: string,
  rawData: unknown
): { channel: string; data: unknown } | null {
  if (channelName.endsWith('.z') && typeof rawData === 'string') {
    const decompressed = decompressPayload(rawData);
    if (decompressed === null) {
      Logger.warn(`Decompression failed for ${channelName} — frame dropped`);
      return null;
    }
    return { channel: channelName.slice(0, -2), data: decompressed };
  }
  return { channel: channelName, data: rawData };
}
```

Replace it with:

```typescript
// Decompresses .z channels while preserving the channel name. The frontend
// matches on the literal names in CHANNELS, which keep the .z suffix.
function resolveChannel(
  channelName: string,
  rawData: unknown
): { channel: string; data: unknown } | null {
  if (channelName.endsWith('.z') && typeof rawData === 'string') {
    const decompressed = decompressPayload(rawData);
    if (decompressed === null) {
      Logger.warn(`Decompression failed for ${channelName} — frame dropped`);
      return null;
    }
    return { channel: channelName, data: decompressed };
  }
  return { channel: channelName, data: rawData };
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 3: Commit**

```bash
git add apps/backend/src/record.ts
git commit -m "fix: preserve .z suffix on recorded channel names"
```

---

## Task 2: Decompress `.z` payloads and alias legacy names in `replay.ts`

The converter stores telemetry compressed, so replay must decompress before broadcasting. The same pass also remaps the legacy `CarData`/`Position` names found in existing recordings, which repairs the bundled Suzuka files.

**Files:**
- Modify: `apps/backend/src/replay.ts`

- [ ] **Step 1: Add imports**

At the top of the file, the imports currently read:

```typescript
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { SocketServer } from '@services/socket-server';
import { Logger } from '@utils/logger';
```

Add `decompressPayload`:

```typescript
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { decompressPayload } from '@services/payload-parser';
import { SocketServer } from '@services/socket-server';
import { Logger } from '@utils/logger';
```

- [ ] **Step 2: Add the normalizer**

Insert this directly above `function startReplay(`:

```typescript
// Recordings made before the .z naming fix stored these channels without the
// suffix, which the frontend never matches. Remap them on the way through.
const LEGACY_CHANNEL_ALIASES: Record<string, string> = {
  CarData: 'CarData.z',
  Position: 'Position.z',
};

// Archive-sourced frames keep .z payloads compressed; recordings store them
// already decompressed. Normalise both to decompressed objects.
function normalizeUpdates(
  updates: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [rawChannel, data] of Object.entries(updates)) {
    const channel = LEGACY_CHANNEL_ALIASES[rawChannel] ?? rawChannel;

    if (channel.endsWith('.z') && typeof data === 'string') {
      const decompressed = decompressPayload(data);
      if (decompressed === null) {
        Logger.warn(`Decompression failed for ${channel} — entry dropped`);
        continue;
      }
      normalized[channel] = decompressed;
      continue;
    }

    normalized[channel] = data;
  }

  return normalized;
}
```

- [ ] **Step 3: Apply it in the tick**

The `tick` function currently reads:

```typescript
  const tick = () => {
    const frame = frames[index];

    if (frame?.updates) {
      // Snapshot frames replace the entire server state atomically
      if (frame.snapshot) {
        socketServer.replaceState(frame.updates);
      } else {
        for (const [channel, data] of Object.entries(frame.updates)) {
          socketServer.broadcast(channel, data);
        }
      }
    }
```

Replace that block with:

```typescript
  const tick = () => {
    const frame = frames[index];

    if (frame?.updates) {
      const updates = normalizeUpdates(frame.updates);

      // Snapshot frames replace the entire server state atomically
      if (frame.snapshot) {
        socketServer.replaceState(updates);
      } else {
        for (const [channel, data] of Object.entries(updates)) {
          socketServer.broadcast(channel, data);
        }
      }
    }
```

- [ ] **Step 4: Verify it type-checks**

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/replay.ts
git commit -m "feat: decompress .z payloads and alias legacy channels in replay"
```

---

## Task 3: Add test tooling

Test files must be excluded from `tsc` (they import with `.ts` extensions, which module `Node16` rejects) and must not ship to `dist/`.

**Files:**
- Modify: `apps/backend/tsconfig.json`
- Modify: `apps/backend/package.json`

- [ ] **Step 1: Exclude tests from the TypeScript build and pin Node types**

`apps/backend/tsconfig.json` currently ends with:

```json
  "include": ["src/**/*"]
}
```

Change to:

```json
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

Also add `"types": ["node"]` to `compilerOptions`, alongside `"composite": true`.

Without it, `tsc --noEmit` passes (it compiles the whole `include` glob, where
some file transitively pulls in `@types/node`) but **`ts-node` fails on any new
file that does not itself import something referencing Node types**, with
`TS2591: Cannot find name 'process'`. The pure converter modules import nothing
at all, so `archive.ts` hits this immediately. Pinning the types makes `tsc` and
`ts-node` agree.

- [ ] **Step 2: Add the test script**

In `apps/backend/package.json`, the `scripts` block currently reads:

```json
  "scripts": {
    "dev": "ts-node -r tsconfig-paths/register src/index.ts",
    "dev:replay": "ts-node -r tsconfig-paths/register src/replay.ts",
    "record": "node --max-old-space-size=8192 -r ts-node/register -r tsconfig-paths/register src/record.ts",
    "lint": "tsc --noEmit",
    "build": "tsc && tsc-alias"
  },
```

Replace with:

```json
  "scripts": {
    "dev": "ts-node -r tsconfig-paths/register src/index.ts",
    "dev:replay": "ts-node -r tsconfig-paths/register src/replay.ts",
    "record": "node --max-old-space-size=8192 -r ts-node/register -r tsconfig-paths/register src/record.ts",
    "archive": "node --max-old-space-size=8192 -r ts-node/register -r tsconfig-paths/register src/archive.ts",
    "test": "node --test \"src/**/*.test.ts\"",
    "lint": "tsc --noEmit",
    "build": "tsc && tsc-alias"
  },
```

- [ ] **Step 3: Verify the build still type-checks**

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/tsconfig.json apps/backend/package.json
git commit -m "chore: add node:test tooling and archive script to backend"
```

---

## Task 4: Parse `.jsonStream` text (pure)

**Files:**
- Create: `apps/backend/src/services/archive-converter.ts`
- Create: `apps/backend/src/services/archive-converter.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/services/archive-converter.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStream } from './archive-converter.ts';

test('parses a timestamped line into ms and payload', () => {
  const result = parseStream('00:00:09.631{"a":1}');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].tMs, 9631);
  assert.deepEqual(result.entries[0].payload, { a: 1 });
  assert.equal(result.skipped, 0);
});

test('converts hours and minutes into milliseconds', () => {
  const result = parseStream('01:02:03.004{}');
  assert.equal(result.entries[0].tMs, 3723004);
});

test('strips a leading BOM', () => {
  const result = parseStream('﻿00:01:00.000{"ok":true}');
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].tMs, 60000);
});

test('handles CRLF line endings and blank lines', () => {
  const result = parseStream('00:00:00.000{"a":1}\r\n\r\n00:00:00.200{"b":2}\r\n');
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries[1].tMs, 200);
});

test('counts malformed lines as skipped instead of throwing', () => {
  const result = parseStream('garbage\n00:00:01.000{"a":1}\n00:00:02.000{oops');
  assert.equal(result.entries.length, 1);
  assert.equal(result.skipped, 2);
});

test('keeps compressed payloads as plain strings', () => {
  const result = parseStream('00:00:01.000"H4sIAAAA"');
  assert.equal(result.entries[0].payload, 'H4sIAAAA');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/backend && node --test src/services/archive-converter.test.ts`
Expected: FAIL — cannot find module `./archive-converter.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/services/archive-converter.ts`:

```typescript
/**
 * Pure conversion of F1 static-archive .jsonStream data into replay frames.
 * Deliberately free of imports so it can be unit-tested under `node --test`
 * without path-alias resolution; callers log the diagnostics it returns.
 */

export interface StreamEntry {
  tMs: number;
  payload: unknown;
}

export interface ParseResult {
  entries: StreamEntry[];
  skipped: number;
}

// Each line is "HH:MM:SS.mmm" followed immediately by JSON, with no separator.
const LINE_PATTERN = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})([\s\S]*)$/;

const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

export function parseStream(text: string): ParseResult {
  const entries: StreamEntry[] = [];
  let skipped = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line) continue;

    const match = LINE_PATTERN.exec(line);
    if (!match) {
      skipped++;
      continue;
    }

    const tMs =
      (Number(match[1]) * SECONDS_PER_HOUR +
        Number(match[2]) * SECONDS_PER_MINUTE +
        Number(match[3])) *
        MS_PER_SECOND +
      Number(match[4]);

    try {
      entries.push({ tMs, payload: JSON.parse(match[5]) as unknown });
    } catch {
      skipped++;
    }
  }

  return { entries, skipped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/backend && node --test src/services/archive-converter.test.ts`
Expected: `pass 6`, `fail 0`. A `MODULE_TYPELESS_PACKAGE_JSON` warning is printed and is expected.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/archive-converter.ts apps/backend/src/services/archive-converter.test.ts
git commit -m "feat: parse F1 archive jsonStream lines"
```

---

## Task 5: Build replay frames from streams (pure)

**Files:**
- Modify: `apps/backend/src/services/archive-converter.ts`
- Modify: `apps/backend/src/services/archive-converter.test.ts`

- [ ] **Step 1: Write the failing tests**

First widen the existing import at the top of `apps/backend/src/services/archive-converter.test.ts`. It currently reads:

```typescript
import { parseStream } from './archive-converter.ts';
```

Change it to (a second `import` from the same module would trip `import/no-duplicates`):

```typescript
import { buildFrames, parseStream, FRAME_MS } from './archive-converter.ts';
```

Then append these tests to the same file:

```typescript
test('prepends a snapshot frame carrying SessionInfo', () => {
  const frames = buildFrames([], { Meeting: { Name: 'Test GP' } });
  assert.equal(frames[0].snapshot, true);
  assert.deepEqual(frames[0].updates, { SessionInfo: { Meeting: { Name: 'Test GP' } } });
});

test('places an entry in the frame matching its timestamp', () => {
  const frames = buildFrames(
    [{ channel: 'TrackStatus', entries: [{ tMs: 250, payload: { Status: '1' } }] }],
    undefined
  );
  // index 0 is the snapshot, so timeline frame N sits at frames[N + 1]
  assert.deepEqual(frames[1 + 2].updates, { TrackStatus: { Status: '1' } });
});

test('pads quiet periods with empty frames to preserve real-time pacing', () => {
  const frames = buildFrames(
    [{ channel: 'LapCount', entries: [{ tMs: 0, payload: { L: 1 } }, { tMs: 500, payload: { L: 2 } }] }],
    undefined
  );
  assert.equal(frames.length, 1 + 6);
  assert.deepEqual(frames[1 + 1].updates, {});
  assert.deepEqual(frames[1 + 5].updates, { LapCount: { L: 2 } });
});

test('spills a colliding discrete channel into the next free frame', () => {
  const frames = buildFrames(
    [
      {
        channel: 'TimingData',
        entries: [
          { tMs: 10, payload: { n: 1 } },
          { tMs: 50, payload: { n: 2 } },
          { tMs: 90, payload: { n: 3 } },
        ],
      },
    ],
    undefined
  );
  // All three land in bin 0, so they occupy three consecutive frames in order.
  assert.deepEqual(frames[1 + 0].updates, { TimingData: { n: 1 } });
  assert.deepEqual(frames[1 + 1].updates, { TimingData: { n: 2 } });
  assert.deepEqual(frames[1 + 2].updates, { TimingData: { n: 3 } });
});

test('overwrites telemetry channels within a frame instead of spilling', () => {
  const frames = buildFrames(
    [
      {
        channel: 'Position.z',
        entries: [
          { tMs: 10, payload: 'first' },
          { tMs: 50, payload: 'second' },
        ],
      },
    ],
    undefined
  );
  assert.equal(frames.length, 1 + 1);
  assert.deepEqual(frames[1].updates, { 'Position.z': 'second' });
});

test('does not merge two channels that share a frame', () => {
  const frames = buildFrames(
    [
      { channel: 'TimingData', entries: [{ tMs: 0, payload: { a: 1 } }] },
      { channel: 'TrackStatus', entries: [{ tMs: 0, payload: { b: 2 } }] },
    ],
    undefined
  );
  assert.deepEqual(frames[1].updates, { TimingData: { a: 1 }, TrackStatus: { b: 2 } });
});

test('frame cadence matches the replay default', () => {
  assert.equal(FRAME_MS, 100);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/backend && node --test src/services/archive-converter.test.ts`
Expected: FAIL — `buildFrames` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `apps/backend/src/services/archive-converter.ts`:

```typescript
export interface ChannelStream {
  channel: string;
  entries: StreamEntry[];
}

export interface ReplayFrame {
  snapshot?: boolean;
  updates: Record<string, unknown>;
}

// Must match the REPLAY_INTERVAL default in replay.ts so playback runs in real time.
export const FRAME_MS = 100;

// Continuous telemetry may be overwritten within a frame. Every other channel
// carries discrete state where merging or dropping corrupts the timeline.
const LAST_WINS_CHANNELS = new Set(['Position.z', 'CarData.z']);

export function buildFrames(
  streams: ChannelStream[],
  sessionInfo: unknown,
  frameMs: number = FRAME_MS
): ReplayFrame[] {
  const timeline: ReplayFrame[] = [];

  const frameAt = (index: number): ReplayFrame => {
    while (timeline.length <= index) timeline.push({ updates: {} });
    return timeline[index];
  };

  for (const { channel, entries } of streams) {
    const isLastWins = LAST_WINS_CHANNELS.has(channel);

    for (const entry of entries) {
      let index = Math.floor(entry.tMs / frameMs);

      // Discrete state is never merged; find the next frame free for this channel.
      if (!isLastWins) {
        while (channel in frameAt(index).updates) index++;
      }

      frameAt(index).updates[channel] = entry.payload;
    }
  }

  const snapshot: ReplayFrame = {
    snapshot: true,
    updates: sessionInfo === undefined ? {} : { SessionInfo: sessionInfo },
  };

  return [snapshot, ...timeline];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/backend && node --test src/services/archive-converter.test.ts`
Expected: `pass 13`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/archive-converter.ts apps/backend/src/services/archive-converter.test.ts
git commit -m "feat: build real-time replay frames from archive streams"
```

---

## Task 6: Parse and select sessions from the season index (pure)

**Files:**
- Create: `apps/backend/src/services/archive-index.ts`
- Create: `apps/backend/src/services/archive-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/backend/src/services/archive-index.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeasonIndex, selectSessions, slugify } from './archive-index.ts';

const INDEX_JSON = JSON.stringify({
  Year: 2026,
  Meetings: [
    {
      Name: 'Pre-Season Testing',
      Number: 1,
      Location: 'Sakhir',
      Country: { Name: 'Bahrain' },
      Sessions: [
        { Name: 'Day 1', Type: 'Practice', StartDate: '2026-02-11T10:00:00', Path: 'p/' },
      ],
    },
    {
      Name: 'Chinese Grand Prix',
      Number: 2,
      Location: 'Shanghai',
      Country: { Name: 'China' },
      Sessions: [
        { Name: 'Sprint', Type: 'Race', StartDate: '2026-03-14T11:00:00', Path: 'cn-sprint/' },
        { Name: 'Race', Type: 'Race', StartDate: '2026-03-15T15:00:00', Path: 'cn-race/' },
      ],
    },
    {
      Name: 'Monaco Grand Prix',
      Number: 6,
      Location: 'Monte Carlo',
      Country: { Name: 'Monaco' },
      Sessions: [
        { Name: 'Race', Type: 'Race', StartDate: '2026-06-07T15:00:00', Path: 'mc-race/' },
      ],
    },
  ],
});

test('slugify strips the Grand Prix suffix', () => {
  assert.equal(slugify('Belgian Grand Prix'), 'belgian');
  assert.equal(slugify('Pre-Season Testing'), 'pre-season-testing');
});

test('excludes meetings without a Race session', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  assert.equal(sessions.some((s) => s.meetingName === 'Pre-Season Testing'), false);
});

test('derives rounds chronologically, ignoring the unreliable Number field', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  const china = sessions.find((s) => s.meetingSlug === 'chinese' && s.sessionName === 'Race');
  const monaco = sessions.find((s) => s.meetingSlug === 'monaco');
  assert.equal(china?.round, 1);
  assert.equal(monaco?.round, 2);
});

test('includes both Race and Sprint sessions', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  const names = sessions.filter((s) => s.meetingSlug === 'chinese').map((s) => s.sessionName);
  assert.deepEqual(names.sort(), ['Race', 'Sprint']);
});

test('selects the Grand Prix by name fragment, case-insensitively', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  const picked = selectSessions(sessions, { name: 'MONACO' });
  assert.equal(picked.length, 1);
  assert.equal(picked[0].path, 'mc-race/');
});

test('matches on location as well as meeting name', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  assert.equal(selectSessions(sessions, { name: 'shanghai' })[0].path, 'cn-race/');
});

test('selects the sprint when the sprint flag is set', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  const picked = selectSessions(sessions, { name: 'chinese', sprint: true });
  assert.equal(picked[0].path, 'cn-sprint/');
});

test('selects by derived round number', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  assert.equal(selectSessions(sessions, { round: 2 })[0].path, 'mc-race/');
});

test('all returns only Grands Prix unless sprints are requested', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  assert.equal(selectSessions(sessions, { all: true }).length, 2);
  assert.equal(selectSessions(sessions, { all: true, sprints: true }).length, 3);
});

test('returns an empty list when nothing matches', () => {
  const sessions = parseSeasonIndex(INDEX_JSON);
  assert.deepEqual(selectSessions(sessions, { name: 'nowhere' }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/backend && node --test src/services/archive-index.test.ts`
Expected: FAIL — cannot find module `./archive-index.ts`.

- [ ] **Step 3: Write the implementation**

Create `apps/backend/src/services/archive-index.ts`:

```typescript
/**
 * Pure parsing and selection over the F1 season index. Deliberately free of
 * imports so it can be unit-tested under `node --test`.
 */

export interface ArchiveSession {
  meetingName: string;
  meetingSlug: string;
  location: string;
  countryName: string;
  sessionName: string;
  round: number;
  startDate: string;
  path: string;
}

export interface SelectOptions {
  name?: string;
  round?: number;
  all?: boolean;
  sprint?: boolean;
  sprints?: boolean;
}

interface RawSession {
  Name?: string;
  Type?: string;
  StartDate?: string;
  Path?: string;
}

interface RawMeeting {
  Name?: string;
  Location?: string;
  Country?: { Name?: string };
  Sessions?: RawSession[];
}

interface RawIndex {
  Meetings?: RawMeeting[];
}

const RACE_SESSION = 'Race';
const SPRINT_SESSION = 'Sprint';

export function slugify(meetingName: string): string {
  return meetingName
    .replace(/\s*Grand Prix\s*/i, ' ')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseSeasonIndex(json: string): ArchiveSession[] {
  const parsed = JSON.parse(json.replace(/^﻿/, '')) as RawIndex;
  const meetings = parsed.Meetings ?? [];

  // A meeting counts as a round only if it has a Race session, which excludes
  // pre-season testing. The Number field in the feed is unreliable (duplicated
  // and out of order), so rounds are derived from the race date instead.
  const rounds = meetings
    .map((meeting) => ({
      meeting,
      race: (meeting.Sessions ?? []).find((s) => s.Name === RACE_SESSION && s.Path),
    }))
    .filter((entry): entry is { meeting: RawMeeting; race: RawSession } =>
      Boolean(entry.race)
    )
    .sort((a, b) =>
      String(a.race.StartDate ?? '').localeCompare(String(b.race.StartDate ?? ''))
    );

  const sessions: ArchiveSession[] = [];

  rounds.forEach(({ meeting }, position) => {
    const meetingName = meeting.Name ?? '';

    for (const session of meeting.Sessions ?? []) {
      if (session.Name !== RACE_SESSION && session.Name !== SPRINT_SESSION) continue;
      if (!session.Path) continue;

      sessions.push({
        meetingName,
        meetingSlug: slugify(meetingName),
        location: meeting.Location ?? '',
        countryName: meeting.Country?.Name ?? '',
        sessionName: session.Name,
        round: position + 1,
        startDate: session.StartDate ?? '',
        path: session.Path,
      });
    }
  });

  return sessions;
}

export function selectSessions(
  sessions: ArchiveSession[],
  options: SelectOptions
): ArchiveSession[] {
  const wanted = options.sprint ? SPRINT_SESSION : RACE_SESSION;

  if (options.all) {
    const included = options.sprints
      ? [RACE_SESSION, SPRINT_SESSION]
      : [RACE_SESSION];
    return sessions
      .filter((s) => included.includes(s.sessionName))
      .sort((a, b) => a.round - b.round || a.startDate.localeCompare(b.startDate));
  }

  if (options.round !== undefined) {
    return sessions.filter(
      (s) => s.round === options.round && s.sessionName === wanted
    );
  }

  if (options.name) {
    const needle = options.name.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sessionName === wanted &&
        (s.meetingName.toLowerCase().includes(needle) ||
          s.meetingSlug.includes(needle) ||
          s.location.toLowerCase().includes(needle) ||
          s.countryName.toLowerCase().includes(needle))
    );
  }

  return [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/backend && node --test src/services/archive-index.test.ts`
Expected: `pass 10`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add apps/backend/src/services/archive-index.ts apps/backend/src/services/archive-index.test.ts
git commit -m "feat: parse and select sessions from the F1 season index"
```

---

## Task 7: Fetch archive files over the network

**Files:**
- Create: `apps/backend/src/services/archive-client.ts`

- [ ] **Step 1: Write the implementation**

Create `apps/backend/src/services/archive-client.ts`:

```typescript
import { Logger } from '@utils/logger';

const ARCHIVE_BASE_URL = 'https://livetiming.formula1.com/static';
const ARCHIVE_HEADERS = { 'User-Agent': 'BestHTTP' } as const;

// The archive answers 403 rather than 404 for keys that do not exist, so both
// statuses mean "this file was never published for this session".
const ABSENT_STATUSES: ReadonlySet<number> = new Set([403, 404]);

// Channel files to pull for a session, mapped to the channel names the frontend
// matches on. The .z suffix is retained: CHANNELS.POSITION is 'Position.z'.
export const ARCHIVE_CHANNEL_FILES: ReadonlyArray<{
  file: string;
  channel: string;
  required: boolean;
}> = [
  { file: 'TimingData.jsonStream', channel: 'TimingData', required: true },
  { file: 'TimingAppData.jsonStream', channel: 'TimingAppData', required: false },
  { file: 'TimingStats.jsonStream', channel: 'TimingStats', required: false },
  { file: 'TrackStatus.jsonStream', channel: 'TrackStatus', required: false },
  { file: 'RaceControlMessages.jsonStream', channel: 'RaceControlMessages', required: false },
  { file: 'WeatherData.jsonStream', channel: 'WeatherData', required: false },
  { file: 'DriverList.jsonStream', channel: 'DriverList', required: false },
  { file: 'SessionData.jsonStream', channel: 'SessionData', required: false },
  { file: 'LapCount.jsonStream', channel: 'LapCount', required: false },
  { file: 'ExtrapolatedClock.jsonStream', channel: 'ExtrapolatedClock', required: false },
  { file: 'Position.z.jsonStream', channel: 'Position.z', required: false },
  { file: 'CarData.z.jsonStream', channel: 'CarData.z', required: false },
];

async function fetchText(url: string): Promise<string | null> {
  let response: Response;

  try {
    response = await fetch(url, { headers: ARCHIVE_HEADERS });
  } catch (error) {
    throw new Error(`Network failure fetching ${url}`, { cause: error });
  }

  if (ABSENT_STATUSES.has(response.status)) return null;

  if (!response.ok) {
    throw new Error(`Archive request failed for ${url} — HTTP ${response.status}`);
  }

  return response.text();
}

export async function fetchSeasonIndex(year: number): Promise<string> {
  const url = `${ARCHIVE_BASE_URL}/${year}/Index.json`;
  const text = await fetchText(url);

  if (text === null) {
    throw new Error(`No archive index published for ${year}`);
  }

  return text;
}

export async function fetchSessionInfo(sessionPath: string): Promise<unknown> {
  const url = `${ARCHIVE_BASE_URL}/${sessionPath}SessionInfo.json`;
  const text = await fetchText(url);

  if (text === null) {
    throw new Error(`SessionInfo.json missing for ${sessionPath}`);
  }

  try {
    return JSON.parse(text.replace(/^﻿/, '')) as unknown;
  } catch (error) {
    throw new Error(`SessionInfo.json is not valid JSON for ${sessionPath}`, {
      cause: error,
    });
  }
}

// Returns null when an optional channel is absent so the caller can skip it.
export async function fetchChannelFile(
  sessionPath: string,
  file: string
): Promise<string | null> {
  const text = await fetchText(`${ARCHIVE_BASE_URL}/${sessionPath}${file}`);

  if (text === null) {
    Logger.warn(`Channel file not published: ${sessionPath}${file}`);
  }

  return text;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 3: Verify it reaches the real archive**

Run:

```bash
cd apps/backend && node -r ts-node/register -r tsconfig-paths/register -e "
require('./src/services/archive-client').fetchSeasonIndex(2026)
  .then(t => console.log('index bytes:', t.length))
  .catch(e => { console.error('FAILED', e); process.exit(1); });
"
```

Expected: `index bytes: 15130` (the exact number may drift as the season progresses; any value above 10000 is fine).

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/services/archive-client.ts
git commit -m "feat: add F1 static archive HTTP client"
```

---

## Task 8: Wire up the CLI

**Files:**
- Create: `apps/backend/src/archive.ts`

- [ ] **Step 1: Write the implementation**

Create `apps/backend/src/archive.ts`:

```typescript
/**
 * Downloads a completed session from the F1 static archive and writes it as
 * ReplayFrame JSON for `pnpm dev:replay`.
 *
 * Usage:
 *   pnpm archive --list
 *   pnpm archive monaco
 *   pnpm archive --round 6
 *   pnpm archive chinese --sprint
 *   pnpm archive --all [--sprints]
 *   pnpm archive monaco --out ./somewhere
 */

import { mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import {
  ARCHIVE_CHANNEL_FILES,
  fetchChannelFile,
  fetchSeasonIndex,
  fetchSessionInfo,
} from '@services/archive-client';
import {
  buildFrames,
  parseStream,
  type ChannelStream,
} from '@services/archive-converter';
import {
  parseSeasonIndex,
  selectSessions,
  type ArchiveSession,
  type SelectOptions,
} from '@services/archive-index';
import { Logger } from '@utils/logger';

const SEASON_YEAR = 2026;
const DEFAULT_OUT_DIR = resolve(__dirname, '../data');

interface CliOptions extends SelectOptions {
  list: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    list: false,
    outDir: DEFAULT_OUT_DIR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--list') {
      options.list = true;
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--sprint') {
      options.sprint = true;
    } else if (arg === '--sprints') {
      options.sprints = true;
    } else if (arg === '--round') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value)) {
        throw new Error('--round requires an integer, e.g. --round 6');
      }
      options.round = value;
    } else if (arg === '--out') {
      const value = argv[++i];
      if (!value) throw new Error('--out requires a directory path');
      options.outDir = resolve(process.cwd(), value);
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      options.name = arg;
    }
  }

  return options;
}

function outputPath(session: ArchiveSession, outDir: string): string {
  const date = session.startDate.slice(0, 10);
  const kind = session.sessionName.toLowerCase();
  return resolve(outDir, `${date}_${session.meetingSlug}_${kind}.json`);
}

async function convertSession(
  session: ArchiveSession,
  outDir: string
): Promise<void> {
  Logger.info(`Fetching ${session.meetingName} ${session.sessionName}...`);

  const sessionInfo = await fetchSessionInfo(session.path);
  const streams: ChannelStream[] = [];
  let skippedTotal = 0;

  for (const { file, channel, required } of ARCHIVE_CHANNEL_FILES) {
    const text = await fetchChannelFile(session.path, file);

    if (text === null) {
      if (required) {
        throw new Error(`Required channel ${file} missing for ${session.path}`);
      }
      continue;
    }

    const { entries, skipped } = parseStream(text);
    skippedTotal += skipped;
    if (entries.length > 0) streams.push({ channel, entries });
  }

  if (skippedTotal > 0) {
    Logger.warn(`Skipped ${skippedTotal} malformed lines`);
  }

  const frames = buildFrames(streams, sessionInfo);
  const target = outputPath(session, outDir);
  const json = JSON.stringify(frames);

  mkdirSync(dirname(target), { recursive: true });
  const tmpPath = `${target}.tmp`;
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, target);

  const sizeMb = (json.length / (1024 * 1024)).toFixed(1);
  Logger.info(`Wrote ${frames.length} frames (${sizeMb}MB) to ${target}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const sessions = parseSeasonIndex(await fetchSeasonIndex(SEASON_YEAR));

  if (options.list) {
    for (const session of sessions) {
      Logger.info(
        `R${String(session.round).padStart(2)} ${session.startDate.slice(0, 10)} ` +
          `${session.meetingName} — ${session.sessionName}`
      );
    }
    return;
  }

  const selected = selectSessions(sessions, options);

  if (selected.length === 0) {
    throw new Error(
      'No session matched. Try `pnpm archive --list` to see what is available.'
    );
  }

  const failures: string[] = [];

  for (const session of selected) {
    try {
      await convertSession(session, options.outDir);
    } catch (error) {
      Logger.error(`Failed ${session.meetingName} ${session.sessionName}`, error);
      failures.push(`${session.meetingName} ${session.sessionName}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} session(s) failed: ${failures.join(', ')}`);
  }
}

main().catch((error) => {
  Logger.error('Archive conversion failed', error);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 3: Verify listing works**

Run: `pnpm --filter backend archive --list`
Expected: one line per session, for example `R10 2026-07-19 Belgian Grand Prix — Race`, with sprints shown under their meeting's round.

- [ ] **Step 4: Commit**

```bash
git add apps/backend/src/archive.ts
git commit -m "feat: add archive CLI for converting completed sessions"
```

---

## Task 9: End-to-end validation

**Files:**
- No source changes; this task verifies the system.

- [ ] **Step 1: Convert a small session first**

Run: `pnpm --filter backend archive monaco`
Expected: `Wrote <n> frames (~20MB) to .../data/2026-06-07_monaco_race.json`. A few `Channel file not published` warnings are acceptable.

- [ ] **Step 2: Sanity-check the output shape**

Run:

```bash
node -e "
const f=require('./apps/backend/data/2026-06-07_monaco_race.json');
console.log('frames:', f.length);
console.log('frame0 snapshot:', f[0].snapshot === true);
console.log('frame0 channels:', Object.keys(f[0].updates));
const ch=new Set(); for(const fr of f) for(const k of Object.keys(fr.updates)) ch.add(k);
console.log('channels present:', [...ch].sort().join(', '));
const empty=f.filter(fr=>Object.keys(fr.updates).length===0).length;
console.log('empty padding frames:', empty);
"
```

Expected: `frame0 snapshot: true`; channel list includes `TimingData`, `TrackStatus`, `Position.z`, and `CarData.z`; a large number of empty padding frames.

- [ ] **Step 3: Golden validation against the live capture**

Convert the Belgian GP race, which was captured live on 2026-07-19 with known results: **910 lap-boundary resets, 6 backward jumps, and a green → yellow → Safety Car → VSC sequence.**

Run: `pnpm --filter backend archive belgian`

Then replay it through the same measurement used on the live feed:

```bash
node --max-old-space-size=4096 -e "
const frames=require('./apps/backend/data/2026-07-19_belgian_race.json');
const SECTOR_KEYS=['0','1','2'];
const COMPLETED=new Set([2048,2049,2051,2064]);
const DROP_FRACTION=0.5, MAX_AFTER=4;
function isObj(v){return v&&typeof v==='object'&&!Array.isArray(v);}
function deepMerge(t,s){
  if(Array.isArray(s)){const b=Array.isArray(t)?t.slice():[];s.forEach((v,i)=>{b[i]=isObj(v)&&isObj(b[i])?deepMerge(b[i],v):v;});return b;}
  if(isObj(s)){const b=isObj(t)?{...t}:{};for(const k of Object.keys(s))b[k]=isObj(s[k])&&isObj(b[k])?deepMerge(b[k],s[k]):s[k];return b;}
  return s;
}
function countSegments(sec){let n=0;for(const k of SECTOR_KEYS){const s=sec&&sec[k]&&sec[k].Segments;n+=Array.isArray(s)?s.length:(s?Object.keys(s).length:0);}return n;}
function countCompleted(sec){if(!sec)return 0;let c=0;
  for(const k of SECTOR_KEYS){const segs=sec[k]&&sec[k].Segments;if(!segs)continue;
    const arr=Array.isArray(segs)?segs:Object.values(segs);
    for(const s of arr){if(!s)continue;if(COMPLETED.has(s.Status??0))c++;else return c;}}
  return c;}
let lines={},total=0,state={},resets=0,back=0,ts='1',statuses=new Set();
for(const fr of frames){
  const u=fr.updates||{};
  if(u.TrackStatus&&u.TrackStatus.Status!==undefined){ts=String(u.TrackStatus.Status);statuses.add(ts);}
  if(!u.TimingData)continue;
  lines=deepMerge({Lines:lines},u.TimingData).Lines;
  if(total===0)for(const l of Object.values(lines)){const n=countSegments(l.Sectors);if(n>0){total=n;break;}}
  if(total===0)continue;
  for(const [no,t] of Object.entries(lines)){
    if(t.Retired||t.Stopped||t.InPit){delete state[no];continue;}
    const c=countCompleted(t.Sectors),prev=state[no];
    const reset=prev&&prev.c-c>total*DROP_FRACTION&&c<=MAX_AFTER;
    let lb; if(!prev)lb=t.NumberOfLaps??0; else if(reset){lb=prev.lb+1;resets++;} else lb=prev.lb;
    const abs=lb*100+c;
    if(prev&&abs<prev.abs-0.5)back++;
    state[no]={lb,c,abs};
  }
}
console.log('segments:',total,'(expect 28 for Spa)');
console.log('lap resets:',resets,'(live capture: 910)');
console.log('backward jumps:',back,'(live capture: 6)');
console.log('track statuses seen:',[...statuses].sort().join(','),'(expect 1,2,4 and ideally 6,7)');
"
```

Expected: `segments: 28`; lap resets in the same order of magnitude as 910; backward jumps low (single digits to low tens); track statuses including `1`, `2`, and `4`.

**Interpreting a mismatch:** resets far below ~900 means entries are being lost or merged — check the spill rule in `buildFrames`. Backward jumps in the hundreds means timing entries are being merged like `record.ts` did — the `LAST_WINS_CHANNELS` set must contain **only** `Position.z` and `CarData.z`.

- [ ] **Step 4: Replay smoke test**

Start the replay server against the converted Monaco file, with the frontend running:

```bash
pnpm --filter backend dev:replay apps/backend/data/2026-06-07_monaco_race.json
```

In a second terminal: `pnpm --filter frontend dev`, then open `http://localhost:3000/live`.

Expected: the timing tower populates, the track map shows moving driver dots, and telemetry renders. Because `Position.z` is present and decompressed by Task 2, the track map should use GPS mode and **not** display the "Estimated positions" badge.

- [ ] **Step 5: Record the Monaco mini-sector count**

Run:

```bash
node -e "
const f=require('./apps/backend/data/2026-06-07_monaco_race.json');
for(const fr of f){const t=(fr.updates||{}).TimingData;if(!t||!t.Lines)continue;
  for(const l of Object.values(t.Lines)){const s=l.Sectors;if(!s)continue;
    let n=0,per=[];for(const k of ['0','1','2']){const g=s[k]&&s[k].Segments;const c=Array.isArray(g)?g.length:(g?Object.keys(g).length:0);per.push(c);n+=c;}
    if(n>0){console.log('Monaco mini-sectors:',n,'per sector:',per.join('+'));process.exit(0);}}}
"
```

Expected: a total and per-sector breakdown, answering the open question about Monaco's segment count.

- [ ] **Step 6: Run the full test suite and lint**

Run: `pnpm --filter backend test`
Expected: `pass 23`, `fail 0`.

Run: `pnpm --filter backend lint`
Expected: exits 0, no output.

- [ ] **Step 7: Commit any fixes and update the roadmap**

If Steps 1-6 required fixes, commit them. Then mark the roadmap item done in `ROADMAP.md` by moving the "Historical race replay from the F1 archive" entry from **Planned** to **Shipped**, recording the observed per-race size and the golden-validation numbers.

```bash
git add ROADMAP.md
git commit -m "docs: mark archive replay converter as shipped"
```

---

## Notes for the implementer

- **Do not add dependencies.** Node 24 provides `node:test`, `assert`, `fetch`, and `zlib`. The project rule is to use only what is already present.
- **Keep the two pure modules import-free.** They are testable precisely because they need no path-alias resolution. If one needs to report a problem, return a count and let the CLI log it.
- **`--all` downloads roughly 220 MB** across 10 Grands Prix (about 22 MB per race, ~9 MB per sprint). Test with a single session before running `--all`.
- **The `MODULE_TYPELESS_PACKAGE_JSON` warning on every test run is expected** and does not indicate a failure.
- Frontend channel names come from `CHANNELS` in `@f1-telemetry/core`. If a channel does not appear in the dashboard, compare the emitted name against that constant first.
