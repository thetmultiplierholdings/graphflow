// THE CONTRACT of tax_demo_workflow: its vocabulary (nodeparamslots and node ids — no raw string literals
// at defineNode call sites) composed from the shared vocabulary plus this version's own, and
// NODEPARAMSLOTS — each nodeparamslot with its authored birth channel and display, exactly what publish writes to
// the nodeparamslots/workflow_nodeparamslots tables. workflow.ts is the implementation.

import type { Nodeparamslot as NodeparamslotDeclaration } from '../../domain/registry/Registry.js';
import { SHARED_NODEPARAMSLOTS, SharedNodeId, SharedNodeparamslot } from '../nodes_shared/enums.js';

export const Nodeparamslot = {
  ...SharedNodeparamslot,
  TaxCalc: 'tax_calc',
  FinalReport: 'final_report',
} as const;

export const NodeId = {
  ...SharedNodeId,
  CalculateTax: 'calculate_tax',
  BuildReport: 'build_report',
} as const;

export const NODEPARAMSLOTS: readonly NodeparamslotDeclaration[] = [
  ...SHARED_NODEPARAMSLOTS,
  { nodeparamslot: Nodeparamslot.TaxCalc, source: 'computed' },
  { nodeparamslot: Nodeparamslot.FinalReport, source: 'computed' },
];
