import { ValidationError } from '../../shared/errors/Errors.js';

// The actor grammar for every created_by/updated_by column: '<type>[:<name>]' with type one of
// user | engine | system | agent. Bare 'user' is the anonymous caller — no auth exists, so names
// are caller-asserted, never verified (standing invariant). The name part is free text and may
// itself contain ':' (the FIRST colon splits); it must be non-empty when present.
//
// Kept sqlite-free: the Temporal bundle (Workflows.ts submit validator) imports this module, so
// nothing here may pull in better-sqlite3 or other node-only infrastructure.
const PRINCIPAL_RE = /^(user|engine|system|agent)(:.+)?$/;

export const isPrincipal = (value: string): boolean => PRINCIPAL_RE.test(value);

// Db write boundaries call this before touching disk (rows OR payload blobs).
export function assertPrincipal(actor: string): void {
  if (!isPrincipal(actor)) {
    throw new ValidationError(
      `'${actor}' is not a principal — expected '<type>[:<name>]' with type user|engine|system|agent`
    );
  }
}
