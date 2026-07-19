// This version's own behavior: the 25% calculator. One node per file, file name == node_id.
import type { ArtifactHandle } from '../../../domain/artifact/ArtifactHandle.js';
import { mulDecimals, quantize2HalfUp, sumDecimals } from '../../../domain/money/DecimalString.js';
import { defineNode } from '../../../domain/registry/Registry.js';
import type { Txn } from '../../nodes_shared/helpers.js';
import { NodeId, Nodeparamslot } from '../enums.js';

const TAX_RATE = '0.25';

export const calculateTax = defineNode({
  name: NodeId.CalculateTax,
  outputNodeparamslot: Nodeparamslot.TaxCalc,
  inputNodeparamslots: { master: Nodeparamslot.MasterTxnList },
  displayName: 'Calculator (mock): sum * 25%',
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
