import { ValidationError } from '../../shared/errors/Errors.js';

// Exact decimal-string arithmetic on BigInt—no floats ever touch a payload (D6). Contracts:
// addition keeps the max operand scale, multiplication sums the operand scales, and
// quantize2HalfUp rounds to exactly two decimal places with ties away from zero.
// Negative zero normalizes to '0' / '0.00' (BigInt has no -0n).

// Optional leading '-', then digits with an optional dot; '.5' and '5.' are accepted, exponents,
// signs like '+', whitespace, and grouping separators are not.
const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;

interface Fixed {
  units: bigint;
  scale: number;
}

function parseDecimal(value: string): Fixed {
  if (!DECIMAL_RE.test(value)) {
    throw new ValidationError(`invalid decimal string: ${JSON.stringify(value)}`);
  }
  const negative = value.startsWith('-');
  const body = negative ? value.slice(1) : value;
  const dot = body.indexOf('.');
  const intPart = dot === -1 ? body : body.slice(0, dot);
  const fracPart = dot === -1 ? '' : body.slice(dot + 1);
  const magnitude = BigInt(`${intPart === '' ? '0' : intPart}${fracPart}`);
  return { units: negative ? -magnitude : magnitude, scale: fracPart.length };
}

function formatFixed(units: bigint, scale: number): string {
  const sign = units < 0n ? '-' : '';
  const abs = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  if (scale === 0) {
    return `${sign}${abs}`;
  }
  return `${sign}${abs.slice(0, abs.length - scale)}.${abs.slice(abs.length - scale)}`;
}

export function sumDecimals(values: readonly string[]): string {
  const parsed = values.map(parseDecimal);
  const scale = parsed.reduce((max, p) => Math.max(max, p.scale), 0);
  let total = 0n;
  for (const p of parsed) {
    total += p.units * 10n ** BigInt(scale - p.scale);
  }
  return formatFixed(total, scale);
}

export function mulDecimals(a: string, b: string): string {
  const pa = parseDecimal(a);
  const pb = parseDecimal(b);
  return formatFixed(pa.units * pb.units, pa.scale + pb.scale);
}

export function quantize2HalfUp(value: string): string {
  const { units, scale } = parseDecimal(value);
  if (scale <= 2) {
    return formatFixed(units * 10n ** BigInt(2 - scale), 2);
  }
  const divisor = 10n ** BigInt(scale - 2);
  let quotient = units / divisor; // BigInt division truncates toward zero
  const remainder = units % divisor; // sign follows the dividend
  const twiceRemainder = 2n * (remainder < 0n ? -remainder : remainder);
  if (twiceRemainder >= divisor) {
    quotient += units < 0n ? -1n : 1n;
  }
  return formatFixed(quotient, 2);
}
