// Tax demo workflow (v1): brokerage statements and payment slips are OCR'd, verified by a human,
// folded into one master transaction list, taxed at 25%, and combined into a single report.
// The nodes live one-per-file in ../nodes_shared/ (version-spanning) and ./nodes_special/ (this
// version's behavior); this file is the DAG — the declaration plus the run() walk.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineWorkflow } from '../../domain/registry/Registry.js';
import { appendToMaster } from '../nodes_shared/append_to_master.js';
import { ocrBrokerageStatement } from '../nodes_shared/ocr_brokerage_statement.js';
import { ocrPaymentSlip } from '../nodes_shared/ocr_payment_slip.js';
import { verifyTxns } from '../nodes_shared/verify_txns.js';
import { KINDS, Kind } from './enums.js';
import { buildReport } from './nodes_special/build_report.js';
import { calculateTax } from './nodes_special/calculate_tax.js';

export const taxDemoWorkflow = defineWorkflow({
  id: 'tax_demo_workflow',
  displayName: 'Tax demo workflow',
  kinds: KINDS,
  nodes: [ocrBrokerageStatement, ocrPaymentSlip, verifyTxns, appendToMaster, calculateTax, buildReport],
  run: async (ctx) => {
    const statements = ctx.attached(Kind.BrokerageStatement);
    const slips = ctx.attached(Kind.PaymentSlip);

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
