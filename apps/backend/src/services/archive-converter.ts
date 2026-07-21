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
