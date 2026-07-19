// This version's own behavior: the 24% calculator fed by the residency questionnaire. RENAMED vs
// v1 (calculate_tax_v2) per the naming contract — node_id is version identity, so an unchanged
// name would keep serving v1's memoized 25% answers. One node per file, file name == node_id.
import type { ArtifactHandle } from '../../../domain/artifact/ArtifactHandle.js';
import { mulDecimals, quantize2HalfUp, sumDecimals } from '../../../domain/money/DecimalString.js';
import { defineNode } from '../../../domain/registry/Registry.js';
import type { Txn } from '../../nodes_shared/helpers.js';
import { NodeId, Nodeparamslot } from '../enums.js';

const TAX_RATE = '0.24';

export const calculateTaxV2 = defineNode({
  name: NodeId.CalculateTaxV2,
  outputNodeparamslot: Nodeparamslot.TaxCalc,
  inputNodeparamslots: { master: Nodeparamslot.MasterTxnList, residency: Nodeparamslot.ResidencyAnswers },
  displayName: 'Calculator (mock): sum * 24%',
  run: async ({ master, residency }: { master: ArtifactHandle; residency: ArtifactHandle }) => {
    const m = (await master.json()) as { transactions: Txn[] };
    const r = (await residency.json()) as { country: string };
    const total = sumDecimals(m.transactions.map((t) => t.amount));
    return {
      total: quantize2HalfUp(total),
      tax_rate: TAX_RATE,
      tax_due: quantize2HalfUp(mulDecimals(total, TAX_RATE)),
      residency: r.country,
    };
  },
});
