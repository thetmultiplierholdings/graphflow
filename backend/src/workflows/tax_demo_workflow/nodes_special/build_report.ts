// This version's own behavior: the report that prints the 25% literal. One node per file,
// file name == node_id.
import type { ArtifactHandle } from '../../../domain/artifact/ArtifactHandle.js';
import { defineNode } from '../../../domain/registry/Registry.js';
import type { Txn } from '../../nodes_shared/helpers.js';
import { NodeId, Nodeparamslot } from '../enums.js';

export const buildReport = defineNode({
  name: NodeId.BuildReport,
  outputNodeparamslot: Nodeparamslot.FinalReport,
  inputNodeparamslots: {
    statements: Nodeparamslot.BrokerageStatement,
    slips: Nodeparamslot.PaymentSlip,
    master: Nodeparamslot.MasterTxnList,
    calc: Nodeparamslot.TaxCalc,
  },
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
    // bytes—never from mutable display names.
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
    lines.push(`  ${'TAX DUE (total * 25%)'.padEnd(40)} ${c.tax_due.padStart(12)}`);
    pages.push(lines.join('\n'));

    const header = `${'='.repeat(64)}\n COMBINED TAX REPORT (graphflow demo)\n${'='.repeat(64)}`;
    return `${header}\n\n${pages.join('\n\n')}\n`;
  },
});
