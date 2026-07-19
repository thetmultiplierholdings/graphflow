import { describe, expect, it } from 'vitest';
import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import type { ArtifactHandle } from '../artifact/ArtifactHandle.js';
import {
  buildRegistry,
  defineHumanNode,
  defineNode,
  defineWorkflow,
  type HumanTask,
  type Kind,
  kindClasses,
  type NodeDef,
  validateCatalog,
  type WorkflowDef,
} from './Registry.js';

const VERIFIED_TXNS_SCHEMA = ['approved', 'transactions'];

const parseLines = (text: string): string[] => text.split('\n');

const ocrStatement = defineNode({
  name: 'ocr_brokerage_statement',
  outputKind: 'ocr_txns',
  inputKinds: { statement: 'brokerage_statement' },
  displayName: 'OCR brokerage statement (mock)',
  run: async ({ statement }: { statement: ArtifactHandle }) => ({
    doc_kind: 'brokerage_statement',
    lines: parseLines(await statement.text()),
  }),
});

const verifyTxns = defineHumanNode({
  name: 'verify_txns',
  outputKind: 'verified_txns',
  inputKinds: { ocr: 'ocr_txns' },
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
  outputKind: 'master_txn_list',
  inputKinds: {},
  run: () => ({ transactions: [] }),
});

const DEFAULT_KINDS: readonly Kind[] = [
  { kind: 'brokerage_statement', source: 'upload', display: 'Brokerage statement (PDF)' },
  { kind: 'ocr_txns', source: 'computed' },
  { kind: 'verified_txns', source: 'computed' },
  { kind: 'master_txn_list', source: 'computed' },
];

const makeWorkflow = (id: string, nodes: readonly NodeDef[], kinds: readonly Kind[] = DEFAULT_KINDS): WorkflowDef =>
  defineWorkflow({
    id,
    kinds,
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
      outputKind: 'tax_calc',
      inputKinds: { master: 'master_txn_list' },
      dedupe: 'hard',
      run: ({ master }: { master: ArtifactHandle }) => ({ hash: master.hash }),
    });
    expect(hard.dedupe).toBe('hard');
    expect(ocrStatement.displayName).toBe('OCR brokerage statement (mock)');
    expect(ocrStatement.paramNames).toEqual(['statement']);
    expect(ocrStatement.inputKinds).toEqual({ statement: 'brokerage_statement' });
  });

  it('accepts null-for-scalar in inputKinds', () => {
    const withScalar = defineNode({
      name: 'threshold_check',
      outputKind: 'tax_calc',
      inputKinds: { master: 'master_txn_list', threshold: null },
      run: ({ master }: { master: ArtifactHandle; threshold: string }) => ({ hash: master.hash }),
    });
    expect(withScalar.inputKinds).toEqual({ master: 'master_txn_list', threshold: null });
  });

  it('derives paramNames from inputKinds in declaration order — inputKinds IS the param declaration', () => {
    const node = defineNode({
      name: 'ordered',
      outputKind: 'tax_calc',
      inputKinds: { second: 'master_txn_list', first: null, third: 'ocr_txns' },
      run: ({ second }: { second: ArtifactHandle; first: string | null; third: ArtifactHandle }) => ({
        hash: second.hash,
      }),
    });
    expect(node.paramNames).toEqual(['second', 'first', 'third']);
    expect(node.paramNames).toEqual(Object.keys(node.inputKinds));
  });

  it('returns frozen definitions that reject mutation in strict mode', () => {
    expect(Object.isFrozen(ocrStatement)).toBe(true);
    expect(Object.isFrozen(ocrStatement.paramNames)).toBe(true);
    expect(Object.isFrozen(ocrStatement.inputKinds)).toBe(true);
    expect(() => {
      (ocrStatement as unknown as { outputKind: string }).outputKind = 'mutated';
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
      outputKind: 'approved_report',
      inputKinds: { report: 'final_report' },
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

describe('kindClasses', () => {
  it('classifies declared kinds: computed iff some node produces them, else leaf', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);
    expect(kindClasses(wd)).toEqual({
      brokerage_statement: 'leaf',
      ocr_txns: 'computed',
      verified_txns: 'computed',
      master_txn_list: 'leaf',
    });
  });
});

describe('validateCatalog', () => {
  // A fully consistent single workflow: every computed kind produced, every leaf unproduced.
  const consistentKinds: readonly Kind[] = [
    { kind: 'brokerage_statement', source: 'upload', display: 'Brokerage statement (PDF)' },
    { kind: 'ocr_txns', source: 'computed' },
    { kind: 'verified_txns', source: 'computed' },
  ];

  it('accepts a reconciled workflow', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], consistentKinds);
    expect(() => validateCatalog([wd])).not.toThrow();
  });

  it('rejects a kind declared twice in one workflow', () => {
    const wd = makeWorkflow(
      'tax_demo_workflow',
      [],
      [
        { kind: 'brokerage_statement', source: 'upload' },
        { kind: 'brokerage_statement', source: 'upload' },
      ]
    );
    expect(() => validateCatalog([wd])).toThrow("tax_demo_workflow: kind 'brokerage_statement' declared twice");
  });

  it('rejects a node whose output kind is undeclared', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement], [{ kind: 'brokerage_statement', source: 'upload' }]);
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow/ocr_brokerage_statement: output kind 'ocr_txns' is not declared by the workflow"
    );
  });

  it('rejects a param consuming an undeclared kind', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement], [{ kind: 'ocr_txns', source: 'computed' }]);
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow/ocr_brokerage_statement: param 'statement' consumes kind 'brokerage_statement' which is not declared by the workflow"
    );
  });

  it('rejects a produced kind declared with a leaf source', () => {
    const wd = makeWorkflow(
      'tax_demo_workflow',
      [ocrStatement, verifyTxns],
      [
        { kind: 'brokerage_statement', source: 'upload' },
        { kind: 'ocr_txns', source: 'upload' },
        { kind: 'verified_txns', source: 'computed' },
      ]
    );
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow: kind 'ocr_txns' is produced by a node but declared with leaf source 'upload'"
    );
  });

  it('rejects an unproduced computed kind unless declared as intake', () => {
    const orphanKinds: readonly Kind[] = [
      { kind: 'brokerage_statement', source: 'upload' },
      { kind: 'ocr_txns', source: 'computed' },
      { kind: 'verified_txns', source: 'computed' },
      { kind: 'master_txn_list', source: 'computed' },
    ];
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], orphanKinds);
    expect(() => validateCatalog([wd])).toThrow(
      "tax_demo_workflow: computed kind 'master_txn_list' has no producing node — declare intake: true if it arrives from another workflow"
    );
    const withIntake = orphanKinds.map((k) => (k.kind === 'master_txn_list' ? ({ ...k, intake: true } as Kind) : k));
    const wd2 = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], withIntake);
    expect(() => validateCatalog([wd2])).not.toThrow();
  });

  it('rejects cross-workflow source/display conflicts for one kind, naming both declarations', () => {
    const a = makeWorkflow('wf_a', [], [{ kind: 'brokerage_statement', source: 'upload', display: 'A' }]);
    const b = makeWorkflow('wf_b', [], [{ kind: 'brokerage_statement', source: 'questionnaire', display: 'A' }]);
    expect(() => validateCatalog([a, b])).toThrow(ValidationError);
    expect(() => validateCatalog([a, b])).toThrow(
      "kind 'brokerage_statement': wf_b declares source 'questionnaire'/display 'A' but wf_a declared 'upload'/'A'"
    );
    const c = makeWorkflow('wf_c', [], [{ kind: 'brokerage_statement', source: 'upload', display: 'DIFFERENT' }]);
    expect(() => validateCatalog([a, c])).toThrow(
      "kind 'brokerage_statement': wf_c declares source 'upload'/display 'DIFFERENT' but wf_a declared 'upload'/'A'"
    );
  });

  it('rejects the same node_id declared with a different shape across workflows — every axis', () => {
    const v1 = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns], consistentKinds);
    const divergences: readonly NodeDef[] = [
      // displayName divergence (the axis that would have caught the v1/v2 25%→24% edit)
      defineNode({
        name: 'ocr_brokerage_statement',
        outputKind: 'ocr_txns',
        inputKinds: { statement: 'brokerage_statement' },
        displayName: 'OCR brokerage statement (DIFFERENT)',
        run: async ({ statement }: { statement: ArtifactHandle }) => ({ lines: [await statement.text()] }),
      }),
      // outputKind divergence
      defineNode({
        name: 'ocr_brokerage_statement',
        outputKind: 'verified_txns',
        inputKinds: { statement: 'brokerage_statement' },
        displayName: 'OCR brokerage statement (mock)',
        run: async ({ statement }: { statement: ArtifactHandle }) => ({ lines: [await statement.text()] }),
      }),
      // param-list divergence
      defineNode({
        name: 'ocr_brokerage_statement',
        outputKind: 'ocr_txns',
        inputKinds: { statement: 'brokerage_statement', page: null },
        displayName: 'OCR brokerage statement (mock)',
        run: async ({ statement }: { statement: ArtifactHandle; page: string }) => ({
          lines: [await statement.text()],
        }),
      }),
      // executor divergence (engine name reused by a human node)
      defineHumanNode({
        name: 'ocr_brokerage_statement',
        outputKind: 'ocr_txns',
        inputKinds: { statement: 'brokerage_statement' },
        title: 'OCR brokerage statement (mock)',
        run: ({ statement }: { statement: ArtifactHandle }): HumanTask => ({
          instructions: 'Extract.',
          payload: { statement },
          resultRequiredKeys: ['lines'],
        }),
      }),
    ];
    for (const divergent of divergences) {
      const v2 = makeWorkflow('tax_demo_workflow_v2', [divergent, verifyTxns], consistentKinds);
      expect(() => validateCatalog([v1, v2])).toThrow(ValidationError);
      expect(() => validateCatalog([v1, v2])).toThrow(
        /node 'ocr_brokerage_statement' is declared with a different shape in tax_demo_workflow_v2 than in tax_demo_workflow/
      );
    }
    // Identical shape under one name across workflows stays legal — that IS the memo-reuse story.
    const twin = makeWorkflow('tax_demo_workflow_v2', [ocrStatement, verifyTxns], consistentKinds);
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
