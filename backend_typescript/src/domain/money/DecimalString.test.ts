import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../shared/errors/Errors.js';
import { mulDecimals, quantize2HalfUp, sumDecimals } from './DecimalString.js';

describe('sumDecimals', () => {
  it('is exact with no precision loss (floats would drift)', () => {
    expect(sumDecimals(Array.from({ length: 10 }, () => '0.1'))).toBe('1.0');
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
  });

  it('matches the integration golden sums from the sample docs', () => {
    // morgan_stanley.txt + payslip_jan.txt amounts (tests-spec expected-value helpers).
    const run1 = ['120.50', '88.20', '45.00', '5200.00', '400.00'];
    expect(sumDecimals(run1)).toBe('5853.70');
    // plus extra_ubs.txt
    expect(sumDecimals([...run1, '66.60', '13.40'])).toBe('5933.70');
  });

  it('keeps the max operand scale on addition', () => {
    expect(sumDecimals(['1', '2.5', '3.25'])).toBe('6.75');
    expect(sumDecimals(['1.500', '2.5'])).toBe('4.000');
  });

  it('handles negatives, mixed signs, and empty input', () => {
    expect(sumDecimals(['-1.25', '0.75'])).toBe('-0.50');
    expect(sumDecimals(['-1.5', '0.5'])).toBe('-1.0');
    expect(sumDecimals([])).toBe('0');
  });

  it('accepts .5 and 5. forms', () => {
    expect(sumDecimals(['.5', '5.'])).toBe('5.5');
    expect(sumDecimals(['-.5', '.25'])).toBe('-0.25');
  });

  it('handles large magnitudes without loss', () => {
    expect(sumDecimals(['123456789012345678901234567890.12', '0.88'])).toBe('123456789012345678901234567891.00');
    expect(sumDecimals(['99999999999999999999.99', '0.01'])).toBe('100000000000000000000.00');
  });

  it('rejects non-decimal strings', () => {
    for (const bad of ['1e5', '', '-', '.', '1,000', ' 1', '1 ', '+1', '1.2.3', 'NaN', '--1', 'abc']) {
      expect(() => sumDecimals([bad]), bad).toThrow(ValidationError);
    }
  });
});

describe('mulDecimals', () => {
  it('is exact and sums the operand scales', () => {
    expect(mulDecimals('0.1', '0.1')).toBe('0.01');
    expect(mulDecimals('5853.70', '0.25')).toBe('1463.4250');
    expect(mulDecimals('1.5', '2.0')).toBe('3.00');
    expect(mulDecimals('2', '3')).toBe('6');
  });

  it('handles signs and dotted forms', () => {
    expect(mulDecimals('-2.5', '4')).toBe('-10.0');
    expect(mulDecimals('-2', '-.5')).toBe('1.0');
    expect(mulDecimals('5.', '.5')).toBe('2.5');
  });

  it('handles large magnitudes', () => {
    expect(mulDecimals('123456789012345678901234567890', '1000000000')).toBe('123456789012345678901234567890000000000');
  });

  it('rejects non-decimal strings', () => {
    expect(() => mulDecimals('1e2', '1')).toThrow(ValidationError);
    expect(() => mulDecimals('1', '')).toThrow(ValidationError);
  });
});

describe('quantize2HalfUp', () => {
  it('reproduces the golden tax fixtures (total x rate, ROUND_HALF_UP to 2dp)', () => {
    // January v1: 17095.95 x 0.25 = 4273.9875 -> 4273.99
    expect(quantize2HalfUp(mulDecimals('17095.95', '0.25'))).toBe('4273.99');
    // February v1: 22450.95 x 0.25 = 5612.7375 -> 5612.74
    expect(quantize2HalfUp(mulDecimals('22450.95', '0.25'))).toBe('5612.74');
    // Blue Harbour v2: 6703.15 x 0.24 = 1608.7560 -> 1608.76
    expect(quantize2HalfUp(mulDecimals('6703.15', '0.24'))).toBe('1608.76');
    // Integration story: 5853.70 x 0.25 = 1463.4250 -> 1463.43; 5933.70 x 0.25 -> 1483.43
    expect(quantize2HalfUp(mulDecimals('5853.70', '0.25'))).toBe('1463.43');
    expect(quantize2HalfUp(mulDecimals('5933.70', '0.25'))).toBe('1483.43');
    // Totals themselves quantize as passthrough to 2dp.
    expect(quantize2HalfUp('17095.95')).toBe('17095.95');
    expect(quantize2HalfUp(sumDecimals(['5853.70', '80.00']))).toBe('5933.70');
  });

  it('pads to exactly two decimal places', () => {
    expect(quantize2HalfUp('1234.5')).toBe('1234.50');
    expect(quantize2HalfUp('7')).toBe('7.00');
    expect(quantize2HalfUp('5.')).toBe('5.00');
    expect(quantize2HalfUp('.5')).toBe('0.50');
    expect(quantize2HalfUp('-3')).toBe('-3.00');
  });

  it('rounds ties away from zero, both signs', () => {
    expect(quantize2HalfUp('2.005')).toBe('2.01');
    expect(quantize2HalfUp('-2.005')).toBe('-2.01');
    expect(quantize2HalfUp('0.125')).toBe('0.13');
    expect(quantize2HalfUp('-0.125')).toBe('-0.13');
    expect(quantize2HalfUp('0.0050')).toBe('0.01');
    expect(quantize2HalfUp('-0.005')).toBe('-0.01');
  });

  it('rounds below the half boundary toward zero', () => {
    expect(quantize2HalfUp('2.00499999')).toBe('2.00');
    expect(quantize2HalfUp('-2.00499999')).toBe('-2.00');
    expect(quantize2HalfUp('0.004999')).toBe('0.00');
  });

  it('carries across all digits at large magnitude', () => {
    expect(quantize2HalfUp('99999999999999999999.995')).toBe('100000000000000000000.00');
    expect(quantize2HalfUp('-99999999999999999999.995')).toBe('-100000000000000000000.00');
  });

  it('normalizes negative zero results to 0.00', () => {
    expect(quantize2HalfUp('-0.001')).toBe('0.00');
    expect(quantize2HalfUp('0')).toBe('0.00');
  });

  it('rejects non-decimal strings', () => {
    expect(() => quantize2HalfUp('12,50')).toThrow(ValidationError);
    expect(() => quantize2HalfUp('1e-2')).toThrow(ValidationError);
  });
});
