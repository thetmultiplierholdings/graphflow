// Tax demo workflow v2: corrects the tax rate from 25% to 24% and adds a residency questionnaire
// feeding the calculator. The four unchanged nodes come one-per-file from ../nodes_shared/ and
// keep their names, so their memoized answers carry over from v1; the two behavior-changed nodes
// live in ./nodes_special/ under NEW names (calculate_tax_v2, build_report_v2). This file is the
// DAG — the declaration plus the run() walk.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineWorkflow } from '../../domain/registry/Registry.js';
import { appendToMaster } from '../nodes_shared/append_to_master.js';
import { ocrBrokerageStatement } from '../nodes_shared/ocr_brokerage_statement.js';
import { ocrPaymentSlip } from '../nodes_shared/ocr_payment_slip.js';
import { verifyTxns } from '../nodes_shared/verify_txns.js';
import { KINDS, Kind } from './enums.js';
import { buildReportV2 } from './nodes_special/build_report_v2.js';
import { calculateTaxV2 } from './nodes_special/calculate_tax_v2.js';

export const taxDemoWorkflowV2 = defineWorkflow({
  id: 'tax_demo_workflow_v2',
  displayName: 'Tax demo workflow v2',
  kinds: KINDS,
  nodes: [ocrBrokerageStatement, ocrPaymentSlip, verifyTxns, appendToMaster, calculateTaxV2, buildReportV2],
  run: async (ctx) => {
    const statements = ctx.attached(Kind.BrokerageStatement);
    const slips = ctx.attached(Kind.PaymentSlip);
    // The questionnaire channel: exactly one answered residency form per run.
    const residency = ctx.attachedOne(Kind.ResidencyAnswers);

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
    const calc = await ctx.node(calculateTaxV2, { master, residency });
    await ctx.node(buildReportV2, { statements, slips, master, calc });
  },
});
