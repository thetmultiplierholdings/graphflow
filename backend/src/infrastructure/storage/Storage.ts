import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NotFoundError } from '../../shared/errors/Errors.js';

// Mock S3/GCS payload store. Layout: {root}/{engagement_id}/{hash} — write-once objects with a
// per-engagement prefix so retention / legal hold / scrubbing operate on one folder.

// The string stored in artifacts.payload_ref.
const payloadRef = (engagementId: number, contentHash: string): string => `${engagementId}/${contentHash}`;

// Write-once: if the object exists it is never rewritten (content-addressed, so identical name
// means identical bytes). Atomic rename with a unique tmp file per writer — concurrent
// identical-output executions must not share a tmp file; whichever rename lands last wins harmlessly.
export function writePayload(root: string, engagementId: number, contentHash: string, data: Uint8Array): string {
  const ref = payloadRef(engagementId, contentHash);
  const path = join(root, ref);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, data);
      renameSync(tmp, path);
    } finally {
      if (existsSync(tmp)) {
        try {
          unlinkSync(tmp);
        } catch {
          // best-effort cleanup
        }
      }
    }
  }
  return ref;
}

export function readPayload(root: string, ref: string): Uint8Array {
  const path = join(root, ref);
  if (!existsSync(path)) {
    throw new NotFoundError(`payload ${ref} not found`, 'payload', ref);
  }
  return readFileSync(path);
}
