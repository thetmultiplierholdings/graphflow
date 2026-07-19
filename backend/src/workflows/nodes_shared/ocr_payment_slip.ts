// Shared across workflow versions: one name, one behavior, everywhere (see enums.ts for the
// sharing contract). File name == node_id, one node per file.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineNode } from '../../domain/registry/Registry.js';
import { SharedNodeId, SharedNodeparamslot } from './enums.js';
import { parseTransactionLines } from './helpers.js';

export const ocrPaymentSlip = defineNode({
  name: SharedNodeId.OcrPaymentSlip,
  outputNodeparamslot: SharedNodeparamslot.OcrTxns,
  inputNodeparamslots: { slip: SharedNodeparamslot.PaymentSlip },
  displayName: 'OCR payment slip (mock)',
  run: async ({ slip }: { slip: ArtifactHandle }) => ({
    doc_nodeparamslot: SharedNodeparamslot.PaymentSlip,
    transactions: parseTransactionLines(await slip.text()),
  }),
});
