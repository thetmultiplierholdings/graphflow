import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import { describe, expect, test } from 'vitest';
import { RuntimeError, ValidationError } from '../shared/errors/Errors.js';
import { RUN_START_POLICIES, rethrowStartError } from './Runtime.js';

// Unit pins for the race-F1 fix. The describe fast path makes the reuse policy unreachable in
// every deterministic scenario (it fires only in the describe/start TOCTOU window), so these
// constants ARE the behavior — a silent regression would survive all integration runs. The
// spread into client.workflow.start (startWorkflowRun) is what makes pinning the object pin the
// call.
describe('dispatch start policies (race F1)', () => {
  test('USE_EXISTING + ALLOW_DUPLICATE_FAILED_ONLY, exactly', () => {
    expect(RUN_START_POLICIES).toEqual({
      workflowIdConflictPolicy: 'USE_EXISTING',
      workflowIdReusePolicy: 'ALLOW_DUPLICATE_FAILED_ONLY',
    });
  });

  test('the server refusing a completed re-start surfaces as RUN_FROZEN, exact message', () => {
    const serverRefusal = new WorkflowExecutionAlreadyStartedError('already started', 'wfrun-abc-42', 'GraphflowRun');
    let caught: unknown;
    try {
      rethrowStartError(serverRefusal, 42);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RuntimeError);
    const err = caught as RuntimeError;
    expect(err.context?.code).toBe('RUN_FROZEN');
    expect(err.message).toBe('workflow run 42 has already completed — create a copy or revision to run it again');
  });

  test('other errors propagate untouched (no swallowing, no rewrapping)', () => {
    const boom = new Error('gRPC deadline exceeded');
    expect(() => rethrowStartError(boom, 42)).toThrow(boom);
    // BaseError subclasses re-throw as themselves via throwIfStandardError.
    const domain = new ValidationError('nope');
    expect(() => rethrowStartError(domain, 42)).toThrow(domain);
  });
});
