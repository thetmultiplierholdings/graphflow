// THE CONTRACT of tax_demo_workflow_v2: its vocabulary (kinds and node ids — no raw string
// literals at defineNode call sites) composed from the shared vocabulary plus this version's own,
// and KINDS — each kind with its authored birth channel and display, exactly what publish writes
// to the kinds/workflow_kinds tables. workflow.ts is the implementation.

import type { Kind as KindDeclaration } from '../../domain/registry/Registry.js';
import { SHARED_KINDS, SharedKind, SharedNodeId } from '../nodes_shared/enums.js';

export const Kind = {
  ...SharedKind,
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

export const KINDS: readonly KindDeclaration[] = [
  ...SHARED_KINDS,
  { kind: Kind.ResidencyAnswers, source: 'questionnaire', display: 'Residency questionnaire' },
  { kind: Kind.TaxCalc, source: 'computed' },
  { kind: Kind.FinalReport, source: 'computed' },
];
