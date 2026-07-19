// Shared across workflow versions: one name, one behavior, everywhere (see enums.ts for the
// sharing contract). File name == node_id, one node per file. The answer contract
// (validateVerifiedTxns) lives with the node it validates.
import type { ArtifactHandle } from '../../domain/artifact/ArtifactHandle.js';
import type { JsonValue } from '../../domain/json/JsonValue.js';
import { defineHumanNode, type HumanTask } from '../../domain/registry/Registry.js';
import { ValidationError } from '../../shared/errors/Errors.js';
import { SharedNodeId, SharedNodeparamslot } from './enums.js';

const VERIFIED_TXNS_SCHEMA = ['approved', 'transactions'];
const DECIMAL_RE = /^-?(\d+(\.\d*)?|\.\d+)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Value rendering for reviewer-facing rejection messages: '...'-quoted strings, True/False, None for null/missing.
function quoteValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => quoteValue(item)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([key, item]) => `${quoteValue(key)}: ${quoteValue(item)}`)
      .join(', ')}}`;
  }
  return String(value);
}

// Answer contract for verify_txns. Accepted answers are memoized forever (one answer per question
// per engagement), so malformed rows must be rejected at submission—never filed into the
// insert-only ledger. Message text is reviewer-facing; keep it byte-stable.
export function validateVerifiedTxns(result: Record<string, JsonValue>): void {
  if (typeof result.approved !== 'boolean') {
    throw new ValidationError("'approved' must be a boolean");
  }
  const txns = result.transactions;
  if (!Array.isArray(txns)) {
    throw new ValidationError("'transactions' must be a list");
  }
  for (const [index, t] of txns.entries()) {
    const i = index + 1;
    if (typeof t !== 'object' || t === null || Array.isArray(t)) {
      throw new ValidationError(`transaction ${i}: must be an object`);
    }
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) {
      throw new ValidationError(`transaction ${i}: date must be YYYY-MM-DD`);
    }
    if (typeof t.description !== 'string' || t.description.trim() === '') {
      throw new ValidationError(`transaction ${i}: description is required`);
    }
    if (typeof t.amount !== 'string' || !DECIMAL_RE.test(t.amount)) {
      throw new ValidationError(
        `transaction ${i}: amount ${quoteValue(t.amount)} must be a plain decimal string like '120.50'`
      );
    }
  }
}

export const verifyTxns = defineHumanNode({
  name: SharedNodeId.VerifyTxns,
  outputNodeparamslot: SharedNodeparamslot.VerifiedTxns,
  inputNodeparamslots: { ocr: SharedNodeparamslot.OcrTxns },
  title: 'Verify OCR extraction',
  resultValidator: validateVerifiedTxns,
  run: ({ ocr }: { ocr: ArtifactHandle }): HumanTask => ({
    instructions:
      'Compare the extracted transactions against the source document. Correct any misread digits, then approve.',
    payload: { ocr },
    resultRequiredKeys: VERIFIED_TXNS_SCHEMA,
  }),
});
