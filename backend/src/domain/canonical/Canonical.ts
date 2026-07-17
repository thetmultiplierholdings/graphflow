import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { ValidationError } from '../../shared/errors/Errors.js';
import type { JsonValue } from '../json/JsonValue.js';

// Canonical JSON + hashing—THE memoization contract (engine-spec §1). Normative rules:
// UTF-8; keys sorted by Unicode code point; no whitespace; strings (keys AND values)
// NFC-normalized BEFORE sorting; floats banned (money is decimal strings).
// Bundle-safe: no node:* imports—this module runs inside the Temporal workflow sandbox.

// JsonValue-shaped; the only numbers accepted at runtime are safe integers.
export type CanonicalInput = JsonValue;

const encoder = new TextEncoder();

// With the u flag this matches lone surrogates only (a valid pair is one astral code point,
// outside the range). Stand-in for String.prototype.isWellFormed (ES2024, not in our lib set).
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function objectTypeName(value: { [key: string]: CanonicalInput }): string {
  return typeof value.constructor === 'function' ? value.constructor.name : 'object';
}

function checkString(value: string, path: string): void {
  if (LONE_SURROGATE.test(value)) {
    throw new ValidationError(`ill-formed string at ${path}: lone surrogates cannot be UTF-8 encoded`);
  }
}

// Type validation runs BEFORE normalization. Paths build as $.key / $[i].
function check(value: CanonicalInput, path: string): void {
  if (value === null) {
    return;
  }
  switch (typeof value) {
    case 'string':
      checkString(value, path);
      return;
    case 'boolean':
      return;
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new ValidationError(
          `float at ${path}: floats are banned in hashed payloads; use decimal strings ('34.50')`
        );
      }
      return;
    case 'object': {
      if (Array.isArray(value)) {
        for (const [i, item] of value.entries()) {
          check(item, `${path}[${i}]`);
        }
        return;
      }
      const proto = Reflect.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        throw new ValidationError(`unsupported type ${objectTypeName(value)} at ${path}`);
      }
      for (const [k, v] of Object.entries(value)) {
        checkString(k, path);
        check(v, `${path}.${k}`);
      }
      return;
    }
    default:
      // undefined / function / symbol / bigint smuggled past the type system.
      throw new ValidationError(`unsupported type ${typeof value} at ${path}`);
  }
}

// NFC-normalize keys AND values, recursively. When two keys collide after normalization, the
// later entry wins (plain assignment overwrites in entry order).
function nfc(value: CanonicalInput): CanonicalInput {
  if (typeof value === 'string') {
    return value.normalize('NFC');
  }
  if (Array.isArray(value)) {
    return value.map(nfc);
  }
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: CanonicalInput } = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.normalize('NFC')] = nfc(v);
    }
    return out;
  }
  return value;
}

// Code-point comparison, NOT default UTF-16 code-unit order (astral chars diverge). UTF-8 byte
// order equals code-point order, so this is "bytewise" per rule 1.
function codePointCompare(a: string, b: string): number {
  const as = [...a];
  const bs = [...b];
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i += 1) {
    const x = as[i].codePointAt(0) ?? -1;
    const y = bs[i].codePointAt(0) ?? -1;
    if (x !== y) {
      return x - y;
    }
  }
  return as.length - bs.length;
}

// Hand-built serialization: JSON.stringify on whole objects would enumerate integer-like keys
// first, breaking sorted order. It is used only to escape strings and format numbers.
function serialize(value: CanonicalInput): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(',')}]`;
  }
  const keys = Object.keys(value).sort(codePointCompare);
  return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(value[k])}`).join(',')}}`;
}

export function canonicalBytes(value: CanonicalInput): Uint8Array {
  check(value, '$');
  return encoder.encode(serialize(nfc(value)));
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? encoder.encode(data) : data));
}

export function hashValue(value: CanonicalInput): string {
  return sha256Hex(canonicalBytes(value));
}

// memo_key = H(code_hash || input_hash). Engagement scoping is applied at lookup time via
// UNIQUE (engagement_id, memo_key)—never inside the hash.
export function memoKey(codeHash: string, inputHash: string): string {
  return sha256Hex(`${codeHash}${inputHash}`);
}
