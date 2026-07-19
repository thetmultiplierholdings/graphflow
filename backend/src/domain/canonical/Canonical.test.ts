import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../shared/errors/Errors.js';
import { canonicalBytes, hashValue, memoKey, sha256Hex } from './Canonical.js';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

// All non-ASCII test data is written as \u escapes so editors/formatters can never
// silently NFC-normalize the source (tests-spec port note).

describe('canonical', () => {
  it('sorted keys, byte exact', () => {
    expect(decode(canonicalBytes({ b: 1, a: 'x' }))).toBe('{"a":"x","b":1}');
    expect(canonicalBytes({ b: 1, a: 'x' })).toEqual(new TextEncoder().encode('{"a":"x","b":1}'));
  });

  it('equal values give equal bytes regardless of key insertion order', () => {
    const one = canonicalBytes({ a: [1, { z: null, y: true }] });
    const two = canonicalBytes({ a: [1, { y: true, z: null }] });
    expect(one).toEqual(two);
  });

  it('integer-like keys still sort by code point, not numeric enumeration order', () => {
    // JSON.stringify over the raw object would enumerate 2 before 10; code-point order is '10' < '2'.
    const value: { [key: string]: number } = {};
    value['10'] = 1;
    value['2'] = 2;
    expect(decode(canonicalBytes(value))).toBe('{"10":1,"2":2}');
  });

  it('non-integer number banned with the exact float message', () => {
    expect(() => canonicalBytes({ amount: 12.5 })).toThrow(ValidationError);
    expect(() => canonicalBytes({ amount: 12.5 })).toThrow(
      "float at $.amount: floats are banned in hashed payloads; use decimal strings ('34.50')"
    );
  });

  it('non-finite and unsafe numbers banned, with array paths', () => {
    expect(() => canonicalBytes({ a: [Number.NaN] })).toThrow(
      "float at $.a[0]: floats are banned in hashed payloads; use decimal strings ('34.50')"
    );
    expect(() => canonicalBytes({ a: Number.POSITIVE_INFINITY })).toThrow(ValidationError);
    expect(() => canonicalBytes({ a: Number.NEGATIVE_INFINITY })).toThrow(ValidationError);
    expect(() => canonicalBytes({ a: Number.MAX_SAFE_INTEGER + 1 })).toThrow(ValidationError);
    expect(() => canonicalBytes(2 ** 60)).toThrow(
      "float at $: floats are banned in hashed payloads; use decimal strings ('34.50')"
    );
    expect(decode(canonicalBytes({ a: Number.MAX_SAFE_INTEGER }))).toBe('{"a":9007199254740991}');
  });

  it('ill-formed strings (lone surrogates) rejected, values and keys', () => {
    expect(() => canonicalBytes({ s: '\uD800' })).toThrow(ValidationError);
    expect(() => canonicalBytes({ s: '\uD800' })).toThrow('ill-formed string at $.s');
    const loneKey = '\uDC00';
    expect(() => canonicalBytes({ [loneKey]: 1 })).toThrow(ValidationError);
    // A well-formed surrogate pair (one astral code point) is fine.
    expect(decode(canonicalBytes({ s: '\u{1F600}' }))).toBe('{"s":"\u{1F600}"}');
  });

  it('artifact reference form hashes stably', () => {
    const ref = { doc: { $artifact: 'ab'.repeat(32) } };
    expect(hashValue(ref)).toBe(hashValue({ doc: { $artifact: 'ab'.repeat(32) } }));
    expect(hashValue(ref)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('NFC normalization applies to values and keys', () => {
    const pre = 'caf\u00E9'; // precomposed e-acute
    const dec = 'cafe\u0301'; // e + combining acute
    expect(pre).not.toBe(dec);
    expect(canonicalBytes({ name: pre })).toEqual(canonicalBytes({ name: dec }));
    expect(hashValue({ [pre]: 1 })).toBe(hashValue({ [dec]: 1 }));
  });

  it('NFC runs before the key sort when normalization changes code-point rank', () => {
    // U+212B ANGSTROM SIGN normalizes to U+00C5, which must sort BEFORE U+1000 MYANMAR KA;
    // the raw (pre-NFC) code points would sort the other way round.
    const angstromSign = '\u212B';
    const latinARing = '\u00C5';
    const myanmarKa = '\u1000';
    expect(decode(canonicalBytes({ [angstromSign]: 1, [myanmarKa]: 2 }))).toBe(`{"${latinARing}":1,"${myanmarKa}":2}`);
    expect(canonicalBytes({ [angstromSign]: 1, [myanmarKa]: 2 })).toEqual(
      canonicalBytes({ [latinARing]: 1, [myanmarKa]: 2 })
    );
  });

  it('keys sort by code point, not UTF-16 code units, for astral characters', () => {
    // U+FF5A (0xFF5A) < U+1F600 (0x1F600) by code point, but the emoji's lead surrogate
    // 0xD83D sorts first under default UTF-16 comparison.
    const fullwidthZ = '\uFF5A';
    const emoji = '\u{1F600}';
    expect(decode(canonicalBytes({ [emoji]: 1, [fullwidthZ]: 2 }))).toBe(`{"${fullwidthZ}":2,"${emoji}":1}`);
  });

  it('memo key composition is deterministic and node-name sensitive', () => {
    const inputHash = 'i'.repeat(64);
    expect(memoKey('calculate_tax', inputHash)).toBe(memoKey('calculate_tax', inputHash));
    // The node's name IS its version identity: a rename opens a new question universe.
    expect(memoKey('calculate_tax', inputHash)).not.toBe(memoKey('calculate_tax_v2', inputHash));
    expect(memoKey('calculate_tax', inputHash)).not.toBe(memoKey('calculate_tax', 'j'.repeat(64)));
    expect(memoKey('calculate_tax', inputHash)).toMatch(/^[0-9a-f]{64}$/);
    // Fixed vector: memo_key = sha256(node_id ':' input_hash) — the key is human-composable now;
    // this pins the exact preimage layout (bare concatenation with a ':' separator).
    expect(memoKey('n', 'i'.repeat(64))).toBe(sha256Hex(`n:${'i'.repeat(64)}`));
  });
});
