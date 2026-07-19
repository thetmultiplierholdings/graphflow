// THE CONTRACT of tax_demo_workflow_v2: its vocabulary (nodeparamslots and node ids — no raw string
// literals at defineNode call sites) composed from the shared vocabulary plus this version's own,
// and NODEPARAMSLOTS — each nodeparamslot with its authored birth channel and display, exactly what publish writes
// to the nodeparamslots/workflow_nodeparamslots tables. workflow.ts is the implementation.

import type { Nodeparamslot as NodeparamslotDeclaration } from '../../domain/registry/Registry.js';
import { SHARED_NODEPARAMSLOTS, SharedNodeId, SharedNodeparamslot } from '../nodes_shared/enums.js';

export const Nodeparamslot = {
  ...SharedNodeparamslot,
  ResidencyAnswers: 'residency_answers',
  TaxCalc: 'tax_calc',
  FinalReport: 'final_report',
} as const;

// calculate_tax_v2 and build_report_v2 carry the _v2 suffix because their behavior diverged from
// v1 (24% rate, residency input): under name identity, an unchanged name keeps v1's memoized
// answers — a rename is what opens a new question universe.
export const NodeId = {
  ...SharedNodeId,
  CalculateTaxV2: 'calculate_tax_v2',
  BuildReportV2: 'build_report_v2',
} as const;

export const NODEPARAMSLOTS: readonly NodeparamslotDeclaration[] = [
  ...SHARED_NODEPARAMSLOTS,
  { nodeparamslot: Nodeparamslot.ResidencyAnswers, source: 'questionnaire', display: 'Residency questionnaire' },
  { nodeparamslot: Nodeparamslot.TaxCalc, source: 'computed' },
  { nodeparamslot: Nodeparamslot.FinalReport, source: 'computed' },
];
