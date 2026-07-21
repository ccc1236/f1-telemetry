/**
 * Trims a replay file so playback starts near the race rather than at the top
 * of the broadcast feed, which can carry an hour of build-up.
 *
 * Everything before the cut is folded into a single snapshot frame, so no
 * accumulated state (DriverList, SessionInfo, stints) is lost. A naive slice
 * leaves the dashboard with empty rows.
 *
 * Usage:
 *   pnpm trim data/2026-03-29_japanese_race.json
 *   pnpm trim data/in.json data/out.json
 *   pnpm trim data/in.json --lead-in 300
 *   pnpm trim data/in.json --segment-mode
 */

import { readFileSync, renameSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { deepMerge } from '@utils/deepMerge';
import { Logger } from '@utils/logger';

// Must match the REPLAY_INTERVAL default in replay.ts.
const FRAME_MS = 100;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const BYTES_PER_MB = 1024 * 1024;

// Lead-in ahead of the detected start. Generous by default so the formation lap
// survives: it runs several minutes before lights out.
const DEFAULT_LEAD_IN_S = 420;

// Channel carrying GPS coordinates. The dashboard switches to GPS positioning
// when it sees these, so dropping them forces the segment-based track map.
const POSITION_CHANNEL = 'Position.z';

interface ReplayFrame {
  snapshot?: boolean;
  updates: Record<string, unknown>;
}

interface TrimOptions {
  inPath: string;
  outPath: string;
  leadInS: number;
  segmentMode: boolean;
}

function parseArgs(argv: string[]): TrimOptions {
  const positional: string[] = [];
  let leadInS = DEFAULT_LEAD_IN_S;
  let segmentMode = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--lead-in') {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('--lead-in requires a non-negative number of seconds');
      }
      leadInS = value;
    } else if (arg === '--segment-mode') {
      segmentMode = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  const [inPath, outPath] = positional;
  if (!inPath) {
    throw new Error('Usage: pnpm trim <input.json> [output.json] [--lead-in S] [--segment-mode]');
  }

  return {
    inPath: resolve(process.cwd(), inPath),
    outPath: resolve(
      process.cwd(),
      outPath ?? inPath.replace(/\.json$/, '_trimmed.json')
    ),
    leadInS,
    segmentMode,
  };
}

// The feed announces lights out via SessionData.StatusSeries. That is exact,
// unlike inferring it from lap counters — lap length varies by ~40% between
// circuits, so no fixed frame offset means the same thing everywhere.
function findSessionStart(frames: ReplayFrame[]): number {
  for (let i = 0; i < frames.length; i++) {
    const sessionData = frames[i].updates?.['SessionData'] as
      | { StatusSeries?: unknown }
      | undefined;
    const series = sessionData?.StatusSeries;
    if (!series) continue;

    const entries = Array.isArray(series)
      ? series
      : Object.values(series as Record<string, unknown>);

    for (const entry of entries) {
      const status = (entry as { SessionStatus?: string } | null)?.SessionStatus;
      if (status === 'Started') return i;
    }
  }
  return -1;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  Logger.info(`Reading ${options.inPath}`);
  const frames = JSON.parse(readFileSync(options.inPath, 'utf-8')) as ReplayFrame[];

  const startFrame = findSessionStart(frames);
  if (startFrame < 0) {
    throw new Error(
      'No SessionStatus "Started" marker found — this may not be a race session'
    );
  }

  const leadInFrames = Math.round((options.leadInS * MS_PER_SECOND) / FRAME_MS);
  const sliceAt = Math.max(0, startFrame - leadInFrames);

  // Fold the skipped frames into one snapshot so state survives the cut.
  let state: Record<string, unknown> = {};
  for (let i = 0; i < sliceAt; i++) {
    state = deepMerge(state, frames[i].updates ?? {}) as Record<string, unknown>;
  }

  const kept = frames.slice(sliceAt);
  const output: ReplayFrame[] = [{ snapshot: true, updates: state }, ...kept];

  if (options.segmentMode) {
    let removed = 0;
    for (const frame of output) {
      if (frame.updates[POSITION_CHANNEL] !== undefined) {
        delete frame.updates[POSITION_CHANNEL];
        removed++;
      }
    }
    Logger.info(`Removed ${removed} ${POSITION_CHANNEL} entries (segment mode)`);
  }

  const json = JSON.stringify(output);
  const tmpPath = `${options.outPath}.tmp`;
  writeFileSync(tmpPath, json, 'utf-8');
  renameSync(tmpPath, options.outPath);

  const toMinutes = (count: number): string =>
    ((count * FRAME_MS) / MS_PER_SECOND / SECONDS_PER_MINUTE).toFixed(1);

  Logger.info(
    `Session started at frame ${startFrame} (${toMinutes(startFrame)} min in)`
  );
  Logger.info(`Cut at frame ${sliceAt} with a ${options.leadInS}s lead-in`);
  Logger.info(`Snapshot carries: ${Object.keys(state).sort().join(', ')}`);
  Logger.info(
    `Frames ${frames.length} -> ${output.length} (${toMinutes(output.length)} min at 1x)`
  );
  Logger.info(
    `Wrote ${(json.length / BYTES_PER_MB).toFixed(1)}MB to ${options.outPath}`
  );
}

try {
  main();
} catch (error) {
  Logger.error('Trim failed', error);
  process.exit(1);
}
