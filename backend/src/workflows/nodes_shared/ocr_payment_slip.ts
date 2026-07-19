// Shared across workflow versions: one name, one behavior, everywhere (see enums.ts for the
// sharing contract). File name == node_id, one node per file.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineNode } from '../../domain/registry/Registry.js';
import { SharedKind, SharedNodeId } from './enums.js';
import { parseTransactionLines } from './helpers.js';

export const ocrPaymentSlip = defineNode({
  name: SharedNodeId.OcrPaymentSlip,
  outputKind: SharedKind.OcrTxns,
  inputKinds: { slip: SharedKind.PaymentSlip },
  displayName: 'OCR payment slip (mock)',
  run: async ({ slip }: { slip: ArtifactHandle }) => ({
    doc_kind: SharedKind.PaymentSlip,
    transactions: parseTransactionLines(await slip.text()),
  }),
});
