// THE CONTRACT of tax_demo_workflow: its vocabulary (kinds and node ids — no raw string literals
// at defineNode call sites) composed from the shared vocabulary plus this version's own, and
// KINDS — each kind with its authored birth channel and display, exactly what publish writes to
// the kinds/workflow_kinds tables. workflow.ts is the implementation.

import type { Kind as KindDeclaration } from '../../domain/registry/Registry.js';
import { SHARED_KINDS, SharedKind, SharedNodeId } from '../nodes_shared/enums.js';

export const Kind = {
  ...SharedKind,
  TaxCalc: 'tax_calc',
  FinalReport: 'final_report',
} as const;

export const NodeId = {
  ...SharedNodeId,
  CalculateTax: 'calculate_tax',
  BuildReport: 'build_report',
} as const;

export const KINDS: readonly KindDeclaration[] = [
  ...SHARED_KINDS,
  { kind: Kind.TaxCalc, source: 'computed' },
  { kind: Kind.FinalReport, source: 'computed' },
];
