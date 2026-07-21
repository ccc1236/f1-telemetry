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
