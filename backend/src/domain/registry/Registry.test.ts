import { describe, expect, it } from 'vitest';
import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import type { ArtifactHandle } from '../artifact/ArtifactHandle.js';
import {
  buildRegistry,
  defineHumanNode,
  defineNode,
  defineWorkflow,
  type HumanTask,
  leafKinds,
  type NodeDef,
  type WorkflowDef,
} from './Registry.js';

const VERIFIED_TXNS_SCHEMA = ['approved', 'transactions'];

const parseLines = (text: string): string[] => text.split('\n');

const ocrStatement = defineNode({
  name: 'ocr_brokerage_statement',
  outputKind: 'ocr_txns',
  params: ['statement'],
  hashWith: [parseLines],
  displayName: 'OCR brokerage statement (mock)',
  run: async ({ statement }: { statement: ArtifactHandle }) => ({
    doc_kind: 'brokerage_statement',
    lines: parseLines(await statement.text()),
  }),
});

const verifyTxns = defineHumanNode({
  name: 'verify_txns',
  outputKind: 'verified_txns',
  params: ['ocr'],
  title: 'Verify OCR extraction',
  hashWith: [VERIFIED_TXNS_SCHEMA],
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
  params: [],
  run: () => ({ transactions: [] }),
});

const makeWorkflow = (id: string, nodes: readonly NodeDef[]): WorkflowDef =>
  defineWorkflow({
    id,
    kinds: [
      { kind: 'brokerage_statement', display: 'Brokerage statement (PDF)' },
      { kind: 'ocr_txns' },
      { kind: 'verified_txns' },
      { kind: 'master_txn_list' },
    ],
    nodes,
    run: async () => undefined,
  });

describe('defineNode', () => {
  it('applies defaults', () => {
    expect(appendToMaster.executor).toBe('engine');
    expect(appendToMaster.dedupe).toBe('none');
    expect(appendToMaster.codeSalt).toBe('');
    expect(appendToMaster.hashWith).toEqual([]);
    expect(appendToMaster.resultValidator).toBeUndefined();
  });

  it('defaults displayName by replacing ALL underscores with spaces', () => {
    expect(appendToMaster.displayName).toBe('append to master list');
  });

  it('keeps explicit config values', () => {
    const salted = defineNode({
      name: 'calc_tax',
      outputKind: 'tax_calc',
      params: ['master'],
      codeSalt: 'v3',
      dedupe: 'hard',
      run: ({ master }: { master: ArtifactHandle }) => ({ hash: master.hash }),
    });
    expect(salted.codeSalt).toBe('v3');
    expect(salted.dedupe).toBe('hard');
    expect(ocrStatement.displayName).toBe('OCR brokerage statement (mock)');
    expect(ocrStatement.paramNames).toEqual(['statement']);
    expect(ocrStatement.hashWith).toEqual([parseLines]);
  });

  it('returns frozen definitions that reject mutation in strict mode', () => {
    expect(Object.isFrozen(ocrStatement)).toBe(true);
    expect(Object.isFrozen(ocrStatement.paramNames)).toBe(true);
    expect(Object.isFrozen(ocrStatement.hashWith)).toBe(true);
    expect(() => {
      (ocrStatement as { codeSalt: string }).codeSalt = 'mutated';
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
      params: ['report'],
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

describe('leafKinds', () => {
  it('marks declared kinds as leaf iff no node produces them', () => {
    const wd = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);
    expect(leafKinds(wd)).toEqual({
      brokerage_statement: true,
      ocr_txns: false,
      verified_txns: false,
      master_txn_list: true,
    });
  });
});

describe('buildRegistry', () => {
  const wf = makeWorkflow('tax_demo_workflow', [ocrStatement, verifyTxns]);
  const hashes = {
    'tax_demo_workflow:ocr_brokerage_statement': 'a'.repeat(64),
    'tax_demo_workflow:verify_txns': 'b'.repeat(64),
  };

  it('exposes workflows and injects code hashes per node', () => {
    const registry = buildRegistry([wf], hashes);
    expect(registry.workflows.get('tax_demo_workflow')).toBe(wf);
    const registered = registry.nodeForWorkflow('tax_demo_workflow', 'ocr_brokerage_statement');
    expect(registered.def).toBe(ocrStatement);
    expect(registered.codeHash).toBe('a'.repeat(64));
    expect(registry.nodeForWorkflow('tax_demo_workflow', 'verify_txns').codeHash).toBe('b'.repeat(64));
  });

  it('throws RuntimeError mentioning gen:hashes when a hash is missing', () => {
    const build = () => buildRegistry([wf], { 'tax_demo_workflow:ocr_brokerage_statement': 'a'.repeat(64) });
    expect(build).toThrow(RuntimeError);
    expect(build).toThrow("no code hash for tax_demo_workflow:verify_txns — run 'npm run gen:hashes'");
  });

  it('rejects duplicate workflow ids', () => {
    const build = () => buildRegistry([wf, wf], hashes);
    expect(build).toThrow(ValidationError);
    expect(build).toThrow("duplicate workflow_id 'tax_demo_workflow'");
  });

  it('nodeForWorkflow throws RuntimeError for unknown workflow or node', () => {
    const registry = buildRegistry([wf], hashes);
    expect(() => registry.nodeForWorkflow('tax_demo_workflow', 'nope')).toThrow(RuntimeError);
    expect(() => registry.nodeForWorkflow('tax_demo_workflow', 'nope')).toThrow('unknown node tax_demo_workflow:nope');
    expect(() => registry.nodeForWorkflow('missing_workflow', 'verify_txns')).toThrow(
      'unknown node missing_workflow:verify_txns'
    );
  });

  it('tryNodeForWorkflow returns undefined instead of throwing', () => {
    const registry = buildRegistry([wf], hashes);
    expect(registry.tryNodeForWorkflow('tax_demo_workflow', 'nope')).toBeUndefined();
    expect(registry.tryNodeForWorkflow('missing_workflow', 'verify_txns')).toBeUndefined();
    expect(registry.tryNodeForWorkflow('tax_demo_workflow', 'verify_txns')?.def).toBe(verifyTxns);
  });
});
