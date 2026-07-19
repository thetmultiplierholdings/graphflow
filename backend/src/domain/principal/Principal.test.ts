import { describe, expect, test } from 'vitest';
import { ValidationError } from '../../shared/errors/Errors.js';
import { assertPrincipal, isPrincipal } from './Principal.js';

describe('principal grammar', () => {
  test.each([
    'user',
    'engine',
    'system',
    'agent',
    'user:thet',
    'user:Priya Sharma',
    'agent:auto-approver',
  ])('accepts %j', (value) => {
    expect(isPrincipal(value)).toBe(true);
    expect(() => assertPrincipal(value)).not.toThrow();
  });

  // The FIRST colon splits; the name part is free text, so it may itself contain ':'.
  test('names may contain colons', () => {
    expect(isPrincipal('user:agent:bot')).toBe(true);
  });

  test.each(['', 'user:', 'alice', 'engineer', 'Unknown', 'USER:thet', 'admin:root'])('rejects %j', (value) => {
    expect(isPrincipal(value)).toBe(false);
    expect(() => assertPrincipal(value)).toThrow(ValidationError);
  });
});
