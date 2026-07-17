// Tax demo workflow v2: corrects the tax rate from 25% to 24%. Every other node is copy-pasted
// unchanged from v1, so OCR results and human answers keep their memo hits across the version bump.
import type { ArtifactHandle } from '../domain/artifact/ArtifactHandle.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { mulDecimals, quantize2HalfUp, sumDecimals } from '../domain/money/DecimalString.js';
import { defineHumanNode, defineNode, defineWorkflow, type HumanTask } from '../domain/registry/Registry.js';
import { ValidationError } from '../shared/errors/Errors.js';

const TAX_RATE = '0.24';
const VERIFIED_TXNS_SCHEMA = ['approved', 'transactions'];
const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

type Txn = { date: string; description: string; amount: string };

// Value rendering for reviewer-facing rejection messages: '...'-quoted strings, True/False, None for null/missing.
function quoteValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => quoteValue(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${quoteValue(key)}: ${quoteValue(item)}`)
      .join(', ')}}`;
  }
  return String(value);
}

// Answer contract for verify_txns. Accepted answers are memoized forever (one answer per question
// per engagement), so malformed rows must be rejected at submission—never filed into the
// insert-only ledger. Message text is reviewer-facing; keep it byte-stable.
export function validateVerifiedTxns(result: Record<string, JsonValue>): void {
  if (typeof result.approved !== 'boolean') {
    throw new ValidationError("'approved' must be a boolean");
  }
  const txns = result.transactions;
  if (!Array.isArray(txns)) {
    throw new ValidationError("'transactions' must be a list");
  }
  for (const [index, t] of txns.entries()) {
    const i = index + 1;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new ValidationError(`transaction ${i}: must be an object`);
    }
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) {
      throw new ValidationError(`transaction ${i}: date must be YYYY-MM-DD`);
    }
    if (typeof t.description !== 'string' || t.description.trim() === '') {
      throw new ValidationError(`transaction ${i}: description is required`);
    }
    if (typeof t.amount !== 'string' || !DECIMAL_RE.test(t.amount)) {
      throw new ValidationError(
        `transaction ${i}: amount ${quoteValue(t.amount)} must be a plain decimal string like '120.50'`
      );
    }
  }
}

// Mock OCR core: lines shaped 'YYYY-MM-DD | DESCRIPTION | 123.45'. Amounts stay decimal STRINGS
// end to end (floats are banned in hashed payloads). Copy-pasted per workflow file on purpose:
// the code-hash codegen resolves hashWith function deps within the owning file.
function parseTransactionLines(text: string): Txn[] {
  const txns: Txn[] = [];
  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim());
    if (parts.length === 3 && parts[0].length === 10 && parts[0][4] === '-') {
      txns.push({ date: parts[0], description: parts[1], amount: parts[2] });
    }
  }
  return txns;
}

export const ocrBrokerageStatement = defineNode({
  name: 'ocr_brokerage_statement',
  outputKind: 'ocr_txns',
  params: ['statement'],
  hashWith: [parseTransactionLines],
  displayName: 'OCR brokerage statement (mock)',
  run: async ({ statement }: { statement: ArtifactHandle }) => ({
    doc_kind: 'brokerage_statement',
    transactions: parseTransactionLines(await statement.text()),
  }),
});

export const ocrPaymentSlip = defineNode({
  name: 'ocr_payment_slip',
  outputKind: 'ocr_txns',
  params: ['slip'],
  hashWith: [parseTransactionLines],
  displayName: 'OCR payment slip (mock)',
  run: async ({ slip }: { slip: ArtifactHandle }) => ({
    doc_kind: 'payment_slip',
    transactions: parseTransactionLines(await slip.text()),
  }),
});

export const verifyTxns = defineHumanNode({
  name: 'verify_txns',
  outputKind: 'verified_txns',
  params: ['ocr'],
  title: 'Verify OCR extraction',
  hashWith: [VERIFIED_TXNS_SCHEMA],
  resultValidator: validateVerifiedTxns,
  run: ({ ocr }: { ocr: ArtifactHandle }): HumanTask => ({
    instructions:
      'Compare the extracted transactions against the source document. Correct any misread digits, then approve.',
    payload: { ocr },
    resultRequiredKeys: VERIFIED_TXNS_SCHEMA,
  }),
});

export const appendToMaster = defineNode({
  name: 'append_to_master',
  outputKind: 'master_txn_list',
  params: ['batches'],
  displayName: 'Append to master transaction list (FOLD)',
  run: async ({ batches }: { batches: ArtifactHandle[] }) => {
    // THE FOLD: N per-document verified batches -> one master list.
    const txns: Txn[] = [];
    for (const batch of batches) {
      const verified = (await batch.json()) as { transactions: Txn[] };
      txns.push(...verified.transactions);
    }
    const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    txns.sort((a, b) => cmp(a.date, b.date) || cmp(a.description, b.description) || cmp(a.amount, b.amount));
    return { transactions: txns, count: txns.length };
  },
});

export const calculateTax = defineNode({
  name: 'calculate_tax',
  outputKind: 'tax_calc',
  params: ['master'],
  hashWith: [TAX_RATE],
  displayName: 'Calculator (mock): sum * 24%',
  run: async ({ master }: { master: ArtifactHandle }) => {
    const m = (await master.json()) as { transactions: Txn[] };
    const total = sumDecimals(m.transactions.map((t) => t.amount));
    return {
      total: quantize2HalfUp(total),
      tax_rate: TAX_RATE,
      tax_due: quantize2HalfUp(mulDecimals(total, TAX_RATE)),
    };
  },
});

export const buildReport = defineNode({
  name: 'build_report',
  outputKind: 'final_report',
  params: ['statements', 'slips', 'master', 'calc'],
  displayName: 'Combine documents into single report',
  run: async ({
    statements,
    slips,
    master,
    calc,
  }: {
    statements: ArtifactHandle[];
    slips: ArtifactHandle[];
    master: ArtifactHandle;
    calc: ArtifactHandle;
  }) => {
    // One 'PDF' (a text file): every source document as a page, then a final page with the
    // summation calculations. Page headers come from the first line of each document's
    // bytes—never from mutable labels.
    const firstLine = (text: string): string => text.split('\n')[0];
    const texts = await Promise.all([...statements, ...slips].map((doc) => doc.text()));
    texts.sort((a, b) => (firstLine(a) < firstLine(b) ? -1 : firstLine(a) > firstLine(b) ? 1 : 0));
    const pages: string[] = [];
    for (const [index, raw] of texts.entries()) {
      const text = raw.trimEnd();
      pages.push(`--- PAGE ${index + 1}: ${firstLine(text)} ---\n${text}`);
    }

    const m = (await master.json()) as { transactions: Txn[]; count: number };
    const c = (await calc.json()) as { total: string; tax_rate: string; tax_due: string };
    const lines = [`--- FINAL PAGE: SUMMATION (${m.count} transactions) ---`];
    for (const t of m.transactions) {
      lines.push(`  ${t.date}  ${t.description.padEnd(28)} ${t.amount.padStart(12)}`);
    }
    lines.push(`  ${'-'.repeat(54)}`);
    lines.push(`  ${'TOTAL'.padEnd(40)} ${c.total.padStart(12)}`);
    lines.push(`  ${'TAX RATE'.padEnd(40)} ${c.tax_rate.padStart(12)}`);
    lines.push(`  ${'TAX DUE (total * 24%)'.padEnd(40)} ${c.tax_due.padStart(12)}`);
    pages.push(lines.join('\n'));

    const header = `${'='.repeat(64)}\n COMBINED TAX REPORT (graphflow demo)\n${'='.repeat(64)}`;
    return `${header}\n\n${pages.join('\n\n')}\n`;
  },
});

export const taxDemoWorkflowV2 = defineWorkflow({
  id: 'tax_demo_workflow_v2',
  displayName: 'Tax demo workflow v2',
  kinds: [
    { kind: 'brokerage_statement', display: 'Brokerage statement (PDF)' },
    { kind: 'payment_slip', display: 'Payment slip (PDF)' },
    { kind: 'ocr_txns' },
    { kind: 'verified_txns' },
    { kind: 'master_txn_list' },
    { kind: 'tax_calc' },
    { kind: 'final_report' },
  ],
  nodes: [ocrBrokerageStatement, ocrPaymentSlip, verifyTxns, appendToMaster, calculateTax, buildReport],
  run: async (ctx) => {
    const statements = ctx.attached('brokerage_statement');
    const slips = ctx.attached('payment_slip');

    const brokerageChain = async (doc: ArtifactHandle): Promise<ArtifactHandle> => {
      const ocr = await ctx.node(ocrBrokerageStatement, { statement: doc });
      return ctx.node(verifyTxns, { ocr }); // human step, memoized
    };
    const slipChain = async (doc: ArtifactHandle): Promise<ArtifactHandle> => {
      const ocr = await ctx.node(ocrPaymentSlip, { slip: doc });
      return ctx.node(verifyTxns, { ocr }); // human step, memoized
    };

    // Parallel chains: reviewer waits overlap; Temporal keeps Promise.all deterministic.
    const batches = await Promise.all([...statements.map(brokerageChain), ...slips.map(slipChain)]);

    const master = await ctx.node(appendToMaster, { batches }); // THE FOLD
    const calc = await ctx.node(calculateTax, { master });
    await ctx.node(buildReport, { statements, slips, master, calc });
  },
});
