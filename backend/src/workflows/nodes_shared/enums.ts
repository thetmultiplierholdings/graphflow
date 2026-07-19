// THE SHARED CONTRACT: the vocabulary of nodes shared across workflow versions (nodes_shared/
// is a shared-code library, not a workflow folder — it has no workflow.ts and never publishes by
// itself). Per-workflow enums compose these into their own Kind/NodeId/KINDS, so a shared kind is
// declared once and can never disagree between workflows. `as const` objects, not TS enums: the
// per-workflow vocabularies are built by spreading these.
//
// The sharing contract: one name, one behavior, everywhere. The memo key is global by node name
// (memo_key = sha256(node_id ':' input_hash)), so same-named nodes across workflows were ALWAYS
// one question universe — sharing the code makes the source layout match. An edit to a shared
// node changes every workflow that lists it, under an unchanged name, so a behavior change here
// forces a RENAME, which re-executes in every importing workflow. Versioned behavior does not
// belong here; it lives in each workflow folder's nodes_special/. One node per file, file name ==
// node_id (enforced by npm run check:workflows).

import type { Kind as KindDeclaration } from '../../domain/registry/Registry.js';

export const SharedKind = {
  BrokerageStatement: 'brokerage_statement',
  PaymentSlip: 'payment_slip',
  OcrTxns: 'ocr_txns',
  VerifiedTxns: 'verified_txns',
  MasterTxnList: 'master_txn_list',
} as const;

export const SharedNodeId = {
  OcrBrokerageStatement: 'ocr_brokerage_statement',
  OcrPaymentSlip: 'ocr_payment_slip',
  VerifyTxns: 'verify_txns',
  AppendToMaster: 'append_to_master',
} as const;

export const SHARED_KINDS: readonly KindDeclaration[] = [
  { kind: SharedKind.BrokerageStatement, source: 'upload', display: 'Brokerage statement (PDF)' },
  { kind: SharedKind.PaymentSlip, source: 'upload', display: 'Payment slip (PDF)' },
  { kind: SharedKind.OcrTxns, source: 'computed' },
  { kind: SharedKind.VerifiedTxns, source: 'computed' },
  { kind: SharedKind.MasterTxnList, source: 'computed' },
];
