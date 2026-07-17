import { Buffer } from 'node:buffer';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { NotFoundError } from '../../shared/errors/Errors.js';
import { readPayload, writePayload } from './Storage.js';

describe('payload storage', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'graphflow-store-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('writePayload stores under {engagement_id}/{hash} and round-trips', () => {
    const data = Buffer.from('hello payload');
    const ref = writePayload(root, 7, 'abc123', data);
    expect(ref).toBe('7/abc123');
    expect(Buffer.from(readPayload(root, ref)).equals(data)).toBe(true);
    expect(readFileSync(join(root, '7', 'abc123')).equals(data)).toBe(true);
  });

  test('writePayload is write-once: an existing object is never rewritten', () => {
    writePayload(root, 7, 'samehash', Buffer.from('first'));
    const ref = writePayload(root, 7, 'samehash', Buffer.from('second'));
    expect(ref).toBe('7/samehash');
    expect(Buffer.from(readPayload(root, ref)).toString('utf-8')).toBe('first');
  });

  test('no tmp files remain after a write', () => {
    writePayload(root, 3, 'h1', Buffer.from('x'));
    expect(readdirSync(join(root, '3'))).toEqual(['h1']);
  });

  test('readPayload throws NotFoundError for a missing ref', () => {
    expect(() => readPayload(root, '9/deadbeef')).toThrow(NotFoundError);
    expect(() => readPayload(root, '9/deadbeef')).toThrow('payload 9/deadbeef not found');
  });
});
