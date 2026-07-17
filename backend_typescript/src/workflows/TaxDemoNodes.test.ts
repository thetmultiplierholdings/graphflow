import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ArtifactHandle } from '../domain/artifact/ArtifactHandle.js';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { errorMessage } from '../shared/errors/Errors.js';
import { ALL_WORKFLOWS } from './index.js';
import {
  appendToMaster,
  buildReport,
  calculateTax,
  ocrBrokerageStatement,
  ocrPaymentSlip,
  taxDemoWorkflow,
  validateVerifiedTxns,
  verifyTxns,
} from './tax_demo_workflow.js';
import {
  appendToMaster as appendToMasterV2,
  buildReport as buildReportV2,
  calculateTax as calculateTaxV2,
  ocrBrokerageStatement as ocrBrokerageStatementV2,
  ocrPaymentSlip as ocrPaymentSlipV2,
  taxDemoWorkflowV2,
} from './tax_demo_workflow_v2.js';

let nextArtifactId = 0;

function payloadHandle(bytes: Uint8Array, kind: string): ArtifactHandle {
  nextArtifactId += 1;
  const ref: ArtifactRef = {
    artifact_id: nextArtifactId,
    hash: `hash-${nextArtifactId}`,
    kind,
    label: null,
    media_type: 'text/plain',
  };
  return new ArtifactHandle(ref, () => Promise.resolve(bytes));
}

const jsonHandle = (value: JsonValue, kind: string): ArtifactHandle =>
  payloadHandle(new TextEncoder().encode(JSON.stringify(value)), kind);

async function sampleDoc(name: string, kind: string): Promise<ArtifactHandle> {
  const bytes = await readFile(new URL(`../../sample_docs/${name}`, import.meta.url));
  return payloadHandle(bytes, kind);
}

async function januaryDocs(): Promise<{ statements: ArtifactHandle[]; slips: ArtifactHandle[] }> {
  const statements = await Promise.all(
    ['morgan_stanley.txt', 'goldman_sachs.txt', 'fidelity.txt'].map((name) => sampleDoc(name, 'brokerage_statement'))
  );
  const slips = await Promise.all(
    ['payslip_jan.txt', 'payslip_feb.txt', 'payslip_mar.txt'].map((name) => sampleDoc(name, 'payment_slip'))
  );
  return { statements, slips };
}

// Runs the per-document chains the way the DAG does, auto-approving each extraction unchanged.
async function verifiedBatchesWith(
  ocrStatement: typeof ocrBrokerageStatement,
  ocrSlip: typeof ocrPaymentSlip,
  statements: ArtifactHandle[],
  slips: ArtifactHandle[]
): Promise<ArtifactHandle[]> {
  const batches: ArtifactHandle[] = [];
  for (const statement of statements) {
    const ocr = await ocrStatement.run({ statement });
    batches.push(jsonHandle({ approved: true, transactions: ocr.transactions }, 'verified_txns'));
  }
  for (const slip of slips) {
    const ocr = await ocrSlip.run({ slip });
    batches.push(jsonHandle({ approved: true, transactions: ocr.transactions }, 'verified_txns'));
  }
  return batches;
}

function rejectionMessage(result: Record<string, JsonValue>): string {
  try {
    validateVerifiedTxns(result);
  } catch (error) {
    return errorMessage(error);
  }
  throw new Error('expected validateVerifiedTxns to reject');
}

const txn = (over: Record<string, JsonValue> = {}): Record<string, JsonValue> => ({
  date: '2026-01-05',
  description: 'DIVIDEND AAPL',
  amount: '120.50',
  ...over,
});

const JANUARY_REPORT = `${'='.repeat(64)}
 COMBINED TAX REPORT (graphflow demo)
${'='.repeat(64)}

--- PAGE 1: FIDELITY BROKERAGE STATEMENT - JAN 2026 ---
FIDELITY BROKERAGE STATEMENT - JAN 2026
ACCOUNT F-55210
--- TRANSACTIONS ---
2026-01-03 | DIVIDEND VTI | 92.10
2026-01-17 | MONEY MARKET INTEREST | 14.90
2026-01-30 | DIVIDEND QQQ | 200.00

--- PAGE 2: GOLDMAN SACHS BROKERAGE STATEMENT - JAN 2026 ---
GOLDMAN SACHS BROKERAGE STATEMENT - JAN 2026
ACCOUNT GS-99120
--- TRANSACTIONS ---
2026-01-09 | DIVIDEND VWRL | 310.00
2026-01-22 | DIVIDEND SPY | 75.25

--- PAGE 3: MORGAN STANLEY BROKERAGE STATEMENT - JAN 2026 ---
MORGAN STANLEY BROKERAGE STATEMENT - JAN 2026
ACCOUNT 4471-8829
--- TRANSACTIONS ---
2026-01-05 | DIVIDEND AAPL | 120.50
2026-01-12 | DIVIDEND MSFT | 88.20
2026-01-28 | BOND INTEREST | 45.00

--- PAGE 4: PAYMENT SLIP - FEBRUARY 2026 ---
PAYMENT SLIP - FEBRUARY 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-02-28 | NET SALARY | 5200.00

--- PAGE 5: PAYMENT SLIP - JANUARY 2026 ---
PAYMENT SLIP - JANUARY 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-01-31 | NET SALARY | 5200.00
2026-01-31 | PERFORMANCE BONUS | 400.00

--- PAGE 6: PAYMENT SLIP - MARCH 2026 ---
PAYMENT SLIP - MARCH 2026
EMPLOYER: ACME LTD
--- PAYMENTS ---
2026-03-31 | NET SALARY | 5200.00
2026-03-31 | OVERTIME | 150.00

--- FINAL PAGE: SUMMATION (13 transactions) ---
  2026-01-03  DIVIDEND VTI                        92.10
  2026-01-05  DIVIDEND AAPL                      120.50
  2026-01-09  DIVIDEND VWRL                      310.00
  2026-01-12  DIVIDEND MSFT                       88.20
  2026-01-17  MONEY MARKET INTEREST               14.90
  2026-01-22  DIVIDEND SPY                        75.25
  2026-01-28  BOND INTEREST                       45.00
  2026-01-30  DIVIDEND QQQ                       200.00
  2026-01-31  NET SALARY                        5200.00
  2026-01-31  PERFORMANCE BONUS                  400.00
  2026-02-28  NET SALARY                        5200.00
  2026-03-31  NET SALARY                        5200.00
  2026-03-31  OVERTIME                           150.00
  ${'-'.repeat(54)}
  TOTAL                                        17095.95
  TAX RATE                                         0.25
  TAX DUE (total * 25%)                         4273.99
`;

const BLUE_HARBOUR_REPORT = `${'='.repeat(64)}
 COMBINED TAX REPORT (graphflow demo)
${'='.repeat(64)}

--- PAGE 1: CHARLES SCHWAB BROKERAGE STATEMENT - FEB 2026 ---
CHARLES SCHWAB BROKERAGE STATEMENT - FEB 2026
ACCOUNT SW-30419
--- TRANSACTIONS ---
2026-02-06 | DIVIDEND VOO | 154.75
2026-02-20 | DIVIDEND SCHD | 98.40

--- PAGE 2: PAYMENT SLIP - FEBRUARY 2026 ---
PAYMENT SLIP - FEBRUARY 2026
EMPLOYER: BLUE HARBOUR LLP
--- PAYMENTS ---
2026-02-27 | NET SALARY | 6100.00
2026-02-27 | CAR ALLOWANCE | 350.00

--- FINAL PAGE: SUMMATION (4 transactions) ---
  2026-02-06  DIVIDEND VOO                       154.75
  2026-02-20  DIVIDEND SCHD                       98.40
  2026-02-27  CAR ALLOWANCE                      350.00
  2026-02-27  NET SALARY                        6100.00
  ${'-'.repeat(54)}
  TOTAL                                         6703.15
  TAX RATE                                         0.24
  TAX DUE (total * 24%)                         1608.76
`;

describe('ocr nodes', () => {
  it('parses transaction lines from a brokerage statement, ignoring headers', async () => {
    const statement = await sampleDoc('morgan_stanley.txt', 'brokerage_statement');
    const out = await ocrBrokerageStatement.run({ statement });
    expect(out).toEqual({
      doc_kind: 'brokerage_statement',
      transactions: [
        { date: '2026-01-05', description: 'DIVIDEND AAPL', amount: '120.50' },
        { date: '2026-01-12', description: 'DIVIDEND MSFT', amount: '88.20' },
        { date: '2026-01-28', description: 'BOND INTEREST', amount: '45.00' },
      ],
    });
  });

  it('parses a payment slip with doc_kind payment_slip', async () => {
    const slip = await sampleDoc('payslip_mar.txt', 'payment_slip');
    const out = await ocrPaymentSlip.run({ slip });
    expect(out).toEqual({
      doc_kind: 'payment_slip',
      transactions: [
        { date: '2026-03-31', description: 'NET SALARY', amount: '5200.00' },
        { date: '2026-03-31', description: 'OVERTIME', amount: '150.00' },
      ],
    });
  });
});

describe('verify_txns', () => {
  it('builds the human question around the ocr artifact', async () => {
    const ocr = jsonHandle({ doc_kind: 'payment_slip', transactions: [] }, 'ocr_txns');
    const task = await verifyTxns.run({ ocr });
    expect(task.instructions).toBe(
      'Compare the extracted transactions against the source document. Correct any misread digits, then approve.'
    );
    expect(task.payload).toEqual({ ocr });
    expect(task.resultRequiredKeys).toEqual(['approved', 'transactions']);
    expect(verifyTxns.executor).toBe('human');
    expect(verifyTxns.dedupe).toBe('hard');
  });
});

describe('validateVerifiedTxns', () => {
  it('accepts a well-formed result', () => {
    expect(() => validateVerifiedTxns({ approved: true, transactions: [txn()] })).not.toThrow();
  });

  it('accepts empty transaction lists and edge-case decimal strings', () => {
    expect(() => validateVerifiedTxns({ approved: false, transactions: [] })).not.toThrow();
    expect(() => validateVerifiedTxns({ approved: true, transactions: [txn({ amount: '-.5' })] })).not.toThrow();
    expect(() => validateVerifiedTxns({ approved: true, transactions: [txn({ amount: '5.' })] })).not.toThrow();
  });

  it('rejects a non-boolean approved flag', () => {
    expect(rejectionMessage({ transactions: [] })).toBe("'approved' must be a boolean");
    expect(rejectionMessage({ approved: 'yes', transactions: [] })).toBe("'approved' must be a boolean");
  });

  it('rejects a missing or non-list transactions value', () => {
    expect(rejectionMessage({ approved: true })).toBe("'transactions' must be a list");
    expect(rejectionMessage({ approved: true, transactions: 'nope' })).toBe("'transactions' must be a list");
  });

  it('rejects malformed rows with 1-based transaction indexes', () => {
    expect(rejectionMessage({ approved: true, transactions: ['nope'] })).toBe('transaction 1: must be an object');
    expect(rejectionMessage({ approved: true, transactions: [txn(), [txn()]] })).toBe(
      'transaction 2: must be an object'
    );
    expect(rejectionMessage({ approved: true, transactions: [txn({ date: '05-01-2026' })] })).toBe(
      'transaction 1: date must be YYYY-MM-DD'
    );
    expect(rejectionMessage({ approved: true, transactions: [txn(), txn({ description: '   ' })] })).toBe(
      'transaction 2: description is required'
    );
  });

  it('rejects non-decimal-string amounts, rendering the offending value in the message', () => {
    expect(rejectionMessage({ approved: true, transactions: [txn({ amount: 120.5 })] })).toBe(
      "transaction 1: amount 120.5 must be a plain decimal string like '120.50'"
    );
    expect(rejectionMessage({ approved: true, transactions: [txn({ amount: '1,200.50' })] })).toBe(
      "transaction 1: amount '1,200.50' must be a plain decimal string like '120.50'"
    );
    expect(rejectionMessage({ approved: true, transactions: [txn({ amount: '120.50 USD' })] })).toBe(
      "transaction 1: amount '120.50 USD' must be a plain decimal string like '120.50'"
    );
    expect(
      rejectionMessage({ approved: true, transactions: [{ date: '2026-01-05', description: 'DIVIDEND AAPL' }] })
    ).toBe("transaction 1: amount None must be a plain decimal string like '120.50'");
  });
});

describe('append_to_master', () => {
  it('folds the January batches into one master list sorted by (date, description, amount)', async () => {
    const { statements, slips } = await januaryDocs();
    const batches = await verifiedBatchesWith(ocrBrokerageStatement, ocrPaymentSlip, statements, slips);
    const master = await appendToMaster.run({ batches });
    expect(master.count).toBe(13);
    expect(master.transactions.map((t) => `${t.date}|${t.description}|${t.amount}`)).toEqual([
      '2026-01-03|DIVIDEND VTI|92.10',
      '2026-01-05|DIVIDEND AAPL|120.50',
      '2026-01-09|DIVIDEND VWRL|310.00',
      '2026-01-12|DIVIDEND MSFT|88.20',
      '2026-01-17|MONEY MARKET INTEREST|14.90',
      '2026-01-22|DIVIDEND SPY|75.25',
      '2026-01-28|BOND INTEREST|45.00',
      '2026-01-30|DIVIDEND QQQ|200.00',
      '2026-01-31|NET SALARY|5200.00',
      '2026-01-31|PERFORMANCE BONUS|400.00',
      '2026-02-28|NET SALARY|5200.00',
      '2026-03-31|NET SALARY|5200.00',
      '2026-03-31|OVERTIME|150.00',
    ]);
  });
});

describe('calculate_tax', () => {
  it('computes the January golden numbers at the v1 25% rate', async () => {
    const { statements, slips } = await januaryDocs();
    const batches = await verifiedBatchesWith(ocrBrokerageStatement, ocrPaymentSlip, statements, slips);
    const master = await appendToMaster.run({ batches });
    const calc = await calculateTax.run({ master: jsonHandle(master, 'master_txn_list') });
    expect(calc).toEqual({ total: '17095.95', tax_rate: '0.25', tax_due: '4273.99' });
  });

  it('computes the February golden numbers once the extra documents are added', async () => {
    const { statements, slips } = await januaryDocs();
    statements.push(await sampleDoc('extra_ubs.txt', 'brokerage_statement'));
    slips.push(await sampleDoc('extra_payslip_apr.txt', 'payment_slip'));
    const batches = await verifiedBatchesWith(ocrBrokerageStatement, ocrPaymentSlip, statements, slips);
    const master = await appendToMaster.run({ batches });
    expect(master.count).toBe(17);
    const calc = await calculateTax.run({ master: jsonHandle(master, 'master_txn_list') });
    expect(calc).toEqual({ total: '22450.95', tax_rate: '0.25', tax_due: '5612.74' });
  });

  it('computes the Blue Harbour golden numbers at the v2 24% rate', async () => {
    const statements = [await sampleDoc('bh_schwab.txt', 'brokerage_statement')];
    const slips = [await sampleDoc('bh_payslip_feb.txt', 'payment_slip')];
    const batches = await verifiedBatchesWith(ocrBrokerageStatementV2, ocrPaymentSlipV2, statements, slips);
    const master = await appendToMasterV2.run({ batches });
    expect(master.count).toBe(4);
    const calc = await calculateTaxV2.run({ master: jsonHandle(master, 'master_txn_list') });
    expect(calc).toEqual({ total: '6703.15', tax_rate: '0.24', tax_due: '1608.76' });
  });
});

describe('build_report', () => {
  it('renders the January report byte-exactly', async () => {
    const { statements, slips } = await januaryDocs();
    const batches = await verifiedBatchesWith(ocrBrokerageStatement, ocrPaymentSlip, statements, slips);
    const master = await appendToMaster.run({ batches });
    const calc = await calculateTax.run({ master: jsonHandle(master, 'master_txn_list') });
    const report = await buildReport.run({
      statements,
      slips,
      master: jsonHandle(master, 'master_txn_list'),
      calc: jsonHandle(calc, 'tax_calc'),
    });
    expect(report).toBe(JANUARY_REPORT);
  });

  it('renders the Blue Harbour v2 report byte-exactly with the 24% literal', async () => {
    const statements = [await sampleDoc('bh_schwab.txt', 'brokerage_statement')];
    const slips = [await sampleDoc('bh_payslip_feb.txt', 'payment_slip')];
    const batches = await verifiedBatchesWith(ocrBrokerageStatementV2, ocrPaymentSlipV2, statements, slips);
    const master = await appendToMasterV2.run({ batches });
    const calc = await calculateTaxV2.run({ master: jsonHandle(master, 'master_txn_list') });
    const report = await buildReportV2.run({
      statements,
      slips,
      master: jsonHandle(master, 'master_txn_list'),
      calc: jsonHandle(calc, 'tax_calc'),
    });
    expect(report).toBe(BLUE_HARBOUR_REPORT);
  });
});

describe('workflow manifest', () => {
  it('lists v1 then v2, differing only in the pinned version-bump metadata', () => {
    expect(ALL_WORKFLOWS.map((wd) => wd.workflowId)).toEqual(['tax_demo_workflow', 'tax_demo_workflow_v2']);
    expect(taxDemoWorkflow.displayName).toBe('Tax demo workflow');
    expect(taxDemoWorkflowV2.displayName).toBe('Tax demo workflow v2');
    expect(calculateTax.displayName).toBe('Calculator (mock): sum * 25%');
    expect(calculateTaxV2.displayName).toBe('Calculator (mock): sum * 24%');
    const nodeIds = [
      'ocr_brokerage_statement',
      'ocr_payment_slip',
      'verify_txns',
      'append_to_master',
      'calculate_tax',
      'build_report',
    ];
    expect(taxDemoWorkflow.nodes.map((node) => node.nodeId)).toEqual(nodeIds);
    expect(taxDemoWorkflowV2.nodes.map((node) => node.nodeId)).toEqual(nodeIds);
    expect(taxDemoWorkflow.kinds.map((kind) => kind.kind)).toEqual(taxDemoWorkflowV2.kinds.map((kind) => kind.kind));
  });
});
