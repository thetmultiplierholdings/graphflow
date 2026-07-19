import { describe, expect, it } from 'vitest';
import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import type { ArtifactHandle } from '../artifact/ArtifactHandle.js';
import {
  buildRegistry,
  defineHumanNode,
  defineNode,
  defineWorkflow,
  type HumanTask,
  type NodeDef,
  type Nodeparamslot,
  nodeparamslotClasses,
  validateCatalog,
  type WorkflowDef,
} from './Registry.js';

const VERIFIED_TXNS_SCHEMA = ['approved', 'transactions'];

const parseLines = (text: string): string[] => text.split('\n');

const ocrStatement = defineNode({
  name: 'ocr_brokerage_statement',
  outputNodeparamslot: 'ocr_txns',
  inputNodeparamslots: { statement: 'brokerage_statement' },
  displayName: 'OCR brokerage statement (mock)',
  run: async ({ statement }: { statement: ArtifactHandle }) => ({
    doc_nodeparamslot: 'brokerage_statement',
    lines: parseLines(await statement.text()),
  }),
});

const verifyTxns = defineHumanNode({
  name: 'verify_txns',
  outputNodeparamslot: 'verified_txns',
  inputNodeparamslots: { ocr: 'ocr_txns' },
  title: 'Verify OCR extraction',
  resultValidator: (result) => {
    if (result.approved !== true) {
      throw new ValidationError('approved must be true');
    }
  },
  run: ({ ocr }: { ocr: ArtifactHandle }): HumanTask => ({
    instructions: 'Compare the extracted transactions against the source document.',
    payload: { ocr },
    resultRequiredKeys: VERIFIED_TXNS_SCHEMA,
  }),
});

const appendToMaster = defineNode({
  name: 'append_to_master_list',
  outputNodeparamslot: 'master_txn_list',
  inputNodeparamslots: {},
  run: () => ({ transactions: [] }),
});

const DEFAULT_NODEPARAMSLOTS: readonly Nodeparamslot[] = [
  { nodeparamslot: 'brokerage_statement', source: 'upload', display: 'Brokerage statement (PDF)' },
  { nodeparamslot: 'ocr_txns', source: 'computed' },
  { nodeparamslot: 'verified_txns', source: 'computed' },
  { nodeparamslot: 'master_txn_list', source: 'computed' },
];

const makeWorkflow = (
  id: string,
  nodes: readonly NodeDef[],
  nodeparamslots: readonly Nodeparamslot[] = DEFAULT_NODEPARAMSLOTS
): WorkflowDef =>
  defineWorkflow({
    id,
    nodeparamslots,
    nodes,
    run: async () => undefined,
  });

describe('defineNode', () => {
  it('applies defaults', () => {
    expect(appendToMaster.executor).toBe('engine');
    expect(appendToMaster.dedupe).toBe('none');
    expect(appendToMaster.resultValidator).toBeUndefined();
  });

  it('defaults displayName by replacing ALL underscores with spaces', () => {
    expect(appendToMaster.displayName).toBe('append to master list');
  });

  it('keeps explicit config values', () => {
    const hard = defineNode({
      name: 'calc_tax',
      outputNodeparamslot: 'tax_calc',
      inputNodeparamslots: { master: 'master_txn_list' },
      dedupe: 'hard',
      run: ({ master }: { master: ArtifactHandle }) => ({ hash: master.hash }),
    });
    expect(hard.dedupe).toBe('hard');
    expect(ocrStatement.displayName).toBe('OCR brokerage statement (mock)');
    expect(ocrStatement.paramNames).toEqual(['statement']);
    expect(ocrStatement.inputNodeparamslots).toEqual({ statement: 'brokerage_statement' });
  });

  it('accepts null-for-scalar in inputNodeparamslots', () => {
    const withScalar = defineNode({
      name: 'threshold_check',
      outputNodeparamslot: 'tax_calc',
      inputNodeparamslots: { master: 'master_txn_list', threshold: null },
      run: ({ master }: { master: ArtifactHandle; threshold: string }) => ({ hash: master.hash }),
    });
    expect(withScalar.inputNodeparamslots).toEqual({ master: 'master_txn_list', threshold: null });
  });

  it('derives paramNames from inputNodeparamslots in declaration order — inputNodeparamslots IS the param declaration', () => {
    const node = defineNode({
      name: 'ordered',
      outputNodeparamslot: 'tax_calc',
      inputNodeparamslots: { second: 'master_txn_list', first: null, third: 'ocr_txns' },
      run: ({ second }: { second: ArtifactHandle; first: string | null; third: ArtifactHandle }) => ({
        hash: second.hash,
      }),
    });
    expect(node.paramNames).toEqual(['second', 'first', 'third']);
    expect(node.paramNames).toEqual(Object.keys(node.inputNodeparamslots));
  });

  it('returns frozen definitions that reject mutation in strict mode', () => {
    expect(Object.isFrozen(ocrStatement)).toBe(true);
    expect(Object.isFrozen(ocrStatement.paramNames)).toBe(true);
    expect(Object.isFrozen(ocrStatement.inputNodeparamslots)).toBe(true);
    expect(() => {
      (ocrStatement as unknown as { outputNodeparamslot: string }).outputNodeparamslot = 'mutated';
    }).toThrow(TypeError);
  });
});

describe('defineHumanNode', () => {
  it('forces hard dedupe and the human executor', () => {
    expect(verifyTxns.executor).toBe('human');
    expect(verifyTxns.dedupe).toBe('hard');
  });

  it('maps title to displayName and falls back to underscore replacement', () => {
    expect(verifyTxns.displayName).toBe('Verify OCR extraction');
    const untitled = defineHumanNode({
      name: 'approve_final_report',
      outputNodeparamslot: 'approved_report',
      inputNodeparamslots: { report: 'final_report' },
      run: ({ report }: { report: ArtifactHandle }): HumanTask => ({
        instructions: 'Approve.',
        payload: { report },
        resultRequiredKeys: ['approved'],
      }),
    });
    expect(untitled.displayName).toBe('approve final report');
  });

  it('carries the resultValidator through', () => {
    expect(verifyTxns.resultValidator).toBeDefined();
    expect(() => verifyTxns.resultValidator?.({ approved: false })).toThrow(ValidationError);
    expect(verifyTxns.resultValidator?.({ approved: true })).toBeUndefined();
  });
});

describe('defineWorkflow', () => {
  it('rejects duplicate node ids within a workflow', () => {
    const build = () => makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns, ocrStatement]);
    expect(build).toThrow(ValidationError);
    expect(build).toThrow("duplicate node_id 'ocr_brokerage_statement' in tax_demo_workflow");
  });

  it('defaults displayName from the id, replacing ALL underscores', () => {
    const wd = makeWorkflow('tax_demo_workflow_v2', [ocrStatement]);
    expect(wd.displayName).toBe('tax demo workflow v2');
  });

  it('freezes the definition and its nodes array', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);
    expect(Object.isFrozen(wd)).toBe(true);
    expect(Object.isFrozen(wd.nodes)).toBe(true);
    expect(() => {
      (wd.nodes as NodeDef[]).push(appendToMaster);
    }).toThrow(TypeError);
  });
});

describe('nodeparamslotClasses', () => {
  it('classifies declared nodeparamslots: computed iff some node produces them, else leaf', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);
    expect(nodeparamslotClasses(wd)).toEqual({
      brokerage_statement: 'leaf',
      ocr_txns: 'computed',
      verified_txns: 'computed',
      master_txn_list: 'leaf',
    });
  });
});

describe('validateCatalog', () => {
  // A fully consistent single workflow: every computed nodeparamslot produced, every leaf unproduced.
  const consistentNodeparamslots: readonly Nodeparamslot[] = [
    { nodeparamslot: 'brokerage_statement', source: 'upload', display: 'Brokerage statement (PDF)' },
    { nodeparamslot: 'ocr_txns', source: 'computed' },
    { nodeparamslot: 'verified_txns', source: 'computed' },
  ];

  it('accepts a reconciled workflow', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], consistentNodeparamslots);
    expect(() => validateCatalog([wd])).not.toThrow();
  });

  it('rejects a nodeparamslot declared twice in one workflow', () => {
    const wd = makeWorkflow(
      'tax_demo_workflow',
      [],
      [
        { nodeparamslot: 'brokerage_statement', source: 'upload' },
        { nodeparamslot: 'brokerage_statement', source: 'upload' },
      ]
    );
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow: nodeparamslot 'brokerage_statement' declared twice"
    );
  });

  it('rejects a node whose output nodeparamslot is undeclared', () => {
    const wd = makeWorkflow(
      'tax_demo_workflow',
      [ocrStatement],
      [{ nodeparamslot: 'brokerage_statement', source: 'upload' }]
    );
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow/ocr_brokerage_statement: output nodeparamslot 'ocr_txns' is not declared by the workflow"
    );
  });

  it('rejects a param consuming an undeclared nodeparamslot', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement], [{ nodeparamslot: 'ocr_txns', source: 'computed' }]);
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow/ocr_brokerage_statement: param 'statement' consumes nodeparamslot 'brokerage_statement' which is not declared by the workflow"
    );
  });

  it('rejects a produced nodeparamslot declared with a leaf source', () => {
    const wd = makeWorkflow(
      'tax_demo_workflow',
      [ocrStatement, verifyTxns],
      [
        { nodeparamslot: 'brokerage_statement', source: 'upload' },
        { nodeparamslot: 'ocr_txns', source: 'upload' },
        { nodeparamslot: 'verified_txns', source: 'computed' },
      ]
    );
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow: nodeparamslot 'ocr_txns' is produced by a node but declared with leaf source 'upload'"
    );
  });

  it('rejects an unproduced computed nodeparamslot unless declared as intake', () => {
    const orphanNodeparamslots: readonly Nodeparamslot[] = [
      { nodeparamslot: 'brokerage_statement', source: 'upload' },
      { nodeparamslot: 'ocr_txns', source: 'computed' },
      { nodeparamslot: 'verified_txns', source: 'computed' },
      { nodeparamslot: 'master_txn_list', source: 'computed' },
    ];
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], orphanNodeparamslots);
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow: computed nodeparamslot 'master_txn_list' has no producing node — declare intake: true if it arrives from another workflow"
    );
    const withIntake = orphanNodeparamslots.map((k) =>
      k.nodeparamslot === 'master_txn_list' ? ({ ...k, intake: true } as Nodeparamslot) : k
    );
    const wd2 = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], withIntake);
    expect(() => validateCatalog([wd2])).not.toThrow();
  });

  it('rejects cross-workflow source/display conflicts for one nodeparamslot, naming both declarations', () => {
    const a = makeWorkflow('wf_a', [], [{ nodeparamslot: 'brokerage_statement', source: 'upload', display: 'A' }]);
    const b = makeWorkflow(
      'wf_b',
      [],
      [{ nodeparamslot: 'brokerage_statement', source: 'questionnaire', display: 'A' }]
    );
    expect(() => validateCatalog([a, b])).toThrow(ValidationError);
    expect(() => validateCatalog([a, b])).toThrow(
      "nodeparamslot 'brokerage_statement': wf_b declares source 'questionnaire'/display 'A' but wf_a declared 'upload'/'A'"
    );
    const c = makeWorkflow(
      'wf_c',
      [],
      [{ nodeparamslot: 'brokerage_statement', source: 'upload', display: 'DIFFERENT' }]
    );
    expect(() => validateCatalog([a, c])).toThrow(
      "nodeparamslot 'brokerage_statement': wf_c declares source 'upload'/display 'DIFFERENT' but wf_a declared 'upload'/'A'"
    );
  });

  it('rejects the same node_id declared with a different shape across workflows — every axis', () => {
    const v1 = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], consistentNodeparamslots);
    const divergences: readonly NodeDef[] = [
      // displayName divergence (the axis that would have caught the v1/v2 25%→24% edit)
      defineNode({
        name: 'ocr_brokerage_statement',
        outputNodeparamslot: 'ocr_txns',
        inputNodeparamslots: { statement: 'brokerage_statement' },
        displayName: 'OCR brokerage statement (DIFFERENT)',
        run: async ({ statement }: { statement: ArtifactHandle }) => ({ lines: [await statement.text()] }),
      }),
      // outputNodeparamslot divergence
      defineNode({
        name: 'ocr_brokerage_statement',
        outputNodeparamslot: 'verified_txns',
        inputNodeparamslots: { statement: 'brokerage_statement' },
        displayName: 'OCR brokerage statement (mock)',
        run: async ({ statement }: { statement: ArtifactHandle }) => ({ lines: [await statement.text()] }),
      }),
      // param-list divergence
      defineNode({
        name: 'ocr_brokerage_statement',
        outputNodeparamslot: 'ocr_txns',
        inputNodeparamslots: { statement: 'brokerage_statement', page: null },
        displayName: 'OCR brokerage statement (mock)',
        run: async ({ statement }: { statement: ArtifactHandle; page: string }) => ({
          lines: [await statement.text()],
        }),
      }),
      // executor divergence (engine name reused by a human node)
      defineHumanNode({
        name: 'ocr_brokerage_statement',
        outputNodeparamslot: 'ocr_txns',
        inputNodeparamslots: { statement: 'brokerage_statement' },
        title: 'OCR brokerage statement (mock)',
        run: ({ statement }: { statement: ArtifactHandle }): HumanTask => ({
          instructions: 'Extract.',
          payload: { statement },
          resultRequiredKeys: ['lines'],
        }),
      }),
    ];
    for (const divergent of divergences) {
      const v2 = makeWorkflow('tax_demo_workflow_v2', [divergent, verifyTxns], consistentNodeparamslots);
      expect(() => validateCatalog([v1, v2])).toThrow(ValidationError);
      expect(() => validateCatalog([v1, v2])).toThrow(
        /node 'ocr_brokerage_statement' is declared with a different shape in tax_demo_workflow_v2 than in tax_demo_workflow/
      );
    }
    // Identical shape under one name across workflows stays legal — that IS the memo-reuse story.
    const twin = makeWorkflow('tax_demo_workflow_v2', [ocrStatement, verifyTxns], consistentNodeparamslots);
    expect(() => validateCatalog([v1, twin])).not.toThrow();
  });
});

describe('buildRegistry', () => {
  const wf = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);

  it('exposes workflows and resolves node defs by (workflow, node)', () => {
    const registry = buildRegistry([wf]);
    expect(registry.workflows.get('tax_demo_workflow')).toBe(wf);
    expect(registry.nodeForWorkflow('tax_demo_workflow', 'ocr_brokerage_statement')).toBe(ocrStatement);
    expect(registry.nodeForWorkflow('tax_demo_workflow', 'verify_txns')).toBe(verifyTxns);
  });

  it('rejects duplicate workflow ids', () => {
    const build = () => buildRegistry([wf, wf]);
    expect(build).toThrow(ValidationError);
    expect(build).toThrow("duplicate workflow_id 'tax_demo_workflow'");
  });

  it('nodeForWorkflow throws RuntimeError for unknown workflow or node', () => {
    const registry = buildRegistry([wf]);
    expect(() => registry.nodeForWorkflow('tax_demo_workflow', 'nope')).toThrow(RuntimeError);
    expect(() => registry.nodeForWorkflow('tax_demo_workflow', 'nope')).toThrow('unknown node tax_demo_workflow:nope');
    expect(() => registry.nodeForWorkflow('missing_workflow', 'verify_txns')).toThrow(
      'unknown node missing_workflow:verify_txns'
    );
  });

  it('tryNodeForWorkflow returns undefined instead of throwing', () => {
    const registry = buildRegistry([wf]);
    expect(registry.tryNodeForWorkflow('tax_demo_workflow', 'nope')).toBeUndefined();
    expect(registry.tryNodeForWorkflow('missing_workflow', 'verify_txns')).toBeUndefined();
    expect(registry.tryNodeForWorkflow('tax_demo_workflow', 'verify_txns')).toBe(verifyTxns);
  });
});
