// Shared across workflow versions: one name, one behavior, everywhere (see enums.ts for the
// sharing contract). File name == node_id, one node per file.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import { defineNode } from '../../domain/registry/Registry.js';
import { SharedNodeId, SharedNodeparamslot } from './enums.js';
import type { Txn } from './helpers.js';

export const appendToMaster = defineNode({
  name: SharedNodeId.AppendToMaster,
  outputNodeparamslot: SharedNodeparamslot.MasterTxnList,
  inputNodeparamslots: { batches: SharedNodeparamslot.VerifiedTxns },
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
