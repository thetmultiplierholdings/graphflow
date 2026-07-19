import { describe, expect, it } from 'vitest';
import { ArtifactHandle } from '../domain/artifact/ArtifactHandle.js';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import { buildRegistry, defineNode, defineWorkflow } from '../domain/registry/Registry.js';
import { Ctx, enforceInputNodeparamslots, type RunInput } from './Context.js';

// Pure-logic coverage of the walk's guards: the inputNodeparamslots runtime enforcement and the attached*
// accessors. Ctx.node's execute paths need a live Temporal activity proxy and are covered by the
// integration suite; every rejection below fires BEFORE any activity call.

let nextId = 0;
function handle(nodeparamslot: string, hash?: string): ArtifactHandle {
  nextId += 1;
  const ref: ArtifactRef = {
    artifact_id: nextId,
    hash: hash ?? `hash-${String(nextId).padStart(3, '0')}`,
    nodeparamslot,
    display_name: null,
    media_type: 'text/plain',
  };
  return new ArtifactHandle(ref);
}

const calc = defineNode({
  name: 'calc_tax',
  outputNodeparamslot: 'tax_calc',
  inputNodeparamslots: { master: 'master_txn_list', threshold: null },
  run: ({ master }: { master: ArtifactHandle; threshold: string | null }) => ({ hash: master.hash }),
});

const fold = defineNode({
  name: 'fold',
  outputNodeparamslot: 'master_txn_list',
  inputNodeparamslots: { batches: 'verified_txns' },
  run: ({ batches }: { batches: ArtifactHandle[] }) => ({ n: batches.length }),
});

describe('enforceInputNodeparamslots', () => {
  it('accepts a matching single handle, a matching list, and absent params', () => {
    expect(() =>
      enforceInputNodeparamslots(calc, { master: handle('master_txn_list'), threshold: null })
    ).not.toThrow();
    expect(() => enforceInputNodeparamslots(calc, { master: null, threshold: null })).not.toThrow();
    expect(() =>
      enforceInputNodeparamslots(fold, { batches: [handle('verified_txns'), handle('verified_txns')] })
    ).not.toThrow();
    expect(() => enforceInputNodeparamslots(fold, { batches: [] })).not.toThrow();
  });

  it('accepts scalar values on scalar params', () => {
    expect(() =>
      enforceInputNodeparamslots(calc, { master: handle('master_txn_list'), threshold: '100.00' })
    ).not.toThrow();
  });

  it('rejects a wrong-nodeparamslot artifact, single or inside a list', () => {
    expect(() => enforceInputNodeparamslots(calc, { master: handle('payment_slip'), threshold: null })).toThrow(
      "node calc_tax: param 'master' expects nodeparamslot 'master_txn_list' but received 'payment_slip'"
    );
    expect(() => enforceInputNodeparamslots(fold, { batches: [handle('verified_txns'), handle('ocr_txns')] })).toThrow(
      "node fold: param 'batches' expects nodeparamslot 'verified_txns' but received 'ocr_txns'"
    );
  });

  it('rejects a wrong-nodeparamslot artifact smuggled inside a nested container', () => {
    expect(() => enforceInputNodeparamslots(fold, { batches: [{ inner: handle('ocr_txns') }] })).toThrow(
      "expects nodeparamslot 'verified_txns' but received 'ocr_txns'"
    );
  });

  it('rejects any artifact on a scalar param', () => {
    expect(() => enforceInputNodeparamslots(calc, { master: null, threshold: handle('tax_calc') })).toThrow(
      "node calc_tax: param 'threshold' is declared scalar but received an artifact of nodeparamslot 'tax_calc'"
    );
  });
});

describe('Ctx', () => {
  const wf = defineWorkflow({
    id: 'wf',
    nodeparamslots: [
      { nodeparamslot: 'verified_txns', source: 'upload' },
      { nodeparamslot: 'master_txn_list', source: 'computed', intake: true },
      { nodeparamslot: 'tax_calc', source: 'computed' },
    ],
    nodes: [calc, fold],
    run: async () => undefined,
  });
  const registry = buildRegistry([wf]);

  function makeCtx(attachments: ArtifactHandle[]): Ctx {
    const inp: RunInput = {
      engagement_id: 7,
      workflow_run_id: 42,
      workflow_id: 'wf',
      declared_nodeparamslots: ['verified_txns', 'master_txn_list', 'tax_calc'],
      attachments: attachments.map((h) => h.ref),
    };
    return new Ctx(inp, registry);
  }

  it('attached() rejects undeclared nodeparamslots and hash-sorts the rest', () => {
    const b = handle('verified_txns', 'bbb');
    const a = handle('verified_txns', 'aaa');
    const ctx = makeCtx([b, a]);
    expect(() => ctx.attached('never_declared')).toThrow(
      "nodeparamslot 'never_declared' is not declared by workflow 'wf'"
    );
    expect(ctx.attached('verified_txns').map((h) => h.hash)).toEqual(['aaa', 'bbb']);
    expect(ctx.attached('tax_calc')).toEqual([]);
  });

  it('attachedOne/attachedOneOrNone enforce cardinality', () => {
    const one = handle('master_txn_list');
    const ctx = makeCtx([one, handle('verified_txns'), handle('verified_txns')]);
    expect(ctx.attachedOne('master_txn_list').artifactId).toBe(one.artifactId);
    expect(() => ctx.attachedOne('verified_txns')).toThrow("expected exactly one 'verified_txns' attachment, found 2");
    expect(() => ctx.attachedOne('tax_calc')).toThrow("expected exactly one 'tax_calc' attachment, found 0");
    expect(ctx.attachedOneOrNone('tax_calc')).toBeNull();
    expect(() => ctx.attachedOneOrNone('verified_txns')).toThrow(
      "expected at most one 'verified_txns' attachment, found 2"
    );
  });

  it('node() rejects unregistered nodes and unknown params before touching any activity', async () => {
    const ctx = makeCtx([]);
    const foreign = defineNode({
      name: 'not_in_wf',
      outputNodeparamslot: 'tax_calc',
      inputNodeparamslots: {},
      run: () => ({ ok: true }),
    });
    await expect(ctx.node(foreign, {})).rejects.toThrow(
      "node 'not_in_wf' is not registered for workflow 'wf' (missing from its nodes list?)"
    );
    await expect(ctx.node(calc, { ghost: 'x' })).rejects.toThrow("unknown parameter 'ghost' for node calc_tax");
  });

  it('node() rejects wrong-nodeparamslot arguments before touching any activity', async () => {
    const ctx = makeCtx([]);
    await expect(ctx.node(calc, { master: handle('verified_txns') })).rejects.toThrow(
      "param 'master' expects nodeparamslot 'master_txn_list' but received 'verified_txns'"
    );
    await expect(ctx.node(calc, { master: null, threshold: handle('tax_calc') })).rejects.toThrow(
      "param 'threshold' is declared scalar but received an artifact"
    );
  });
});
