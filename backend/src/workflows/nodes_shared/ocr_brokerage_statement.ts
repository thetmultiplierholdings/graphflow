// Shared across workflow versions: one name, one behavior, everywhere (see enums.ts for the
// sharing contract). File name == node_id, one node per file.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineNode } from '../../domain/registry/Registry.js';
import { SharedNodeId, SharedNodeparamslot } from './enums.js';
import { parseTransactionLines } from './helpers.js';

export const ocrBrokerageStatement = defineNode({
  name: SharedNodeId.OcrBrokerageStatement,
  outputNodeparamslot: SharedNodeparamslot.OcrTxns,
  inputNodeparamslots: { statement: SharedNodeparamslot.BrokerageStatement },
  displayName: 'OCR brokerage statement (mock)',
  run: async ({ statement }: { statement: ArtifactHandle }) => ({
    doc_nodeparamslot: SharedNodeparamslot.BrokerageStatement,
    transactions: parseTransactionLines(await statement.text()),
  }),
});
