import { ApplicationFailure } from '@temporalio/common';
import { proxyActivities, sleep } from '@temporalio/workflow';
import { ArtifactHandle } from '../domain/artifact/ArtifactHandle.js';
import type { ArtifactRef } from '../domain/artifact/ArtifactRef.js';
import { hashValue, memoKey } from '../domain/canonical/Canonical.js';
import type { JsonValue } from '../domain/json/JsonValue.js';
import type { NodeArgValue, NodeDef, Registry } from '../domain/registry/Registry.js';
import type { Acts } from './Activities.js';

// Ctx: the memoize-or-execute walk. SANDBOX code — imports limited to @temporalio/*, domain
// modules and type-only activity shapes; every DB/IO touch happens in an activity.

// RunInput/Summary/NodeRequest keep snake_case keys: they live in Temporal payloads and
// DB-adjacent transport, so the key spelling is wire contract.
export interface RunInput {
  engagement_id: number;
  workflow_run_id: number;
  workflow_id: string;
  declared_kinds: string[];
  attachments: ArtifactRef[];
}

export interface Summary {
  workflow_run_id: number;
  executed: string[];
  memo_hits: string[];
  human_waits: string[];
}

export type TransportValue =
  | JsonValue
  | { __artifact__: ArtifactRef }
  | TransportValue[]
  | { [key: string]: TransportValue };

export interface NodeRequest {
  engagement_id: number;
  workflow_run_id: number;
  workflow_id: string;
  node_id: string;
  memo_key: string;
  args_transport: TransportValue;
  input_artifact_ids: number[];
}

interface EncodedArgs {
  hashForm: JsonValue;
  transport: TransportValue;
  inputArtifactIds: number[];
}

const compareStrings = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

// Non-empty all-ArtifactHandle lists are sorted by content hash (canonical rule 6); mixed or
// non-artifact lists keep caller order.
function sortedIfAllArtifacts(items: readonly NodeArgValue[]): readonly NodeArgValue[] {
  const handles: ArtifactHandle[] = [];
  for (const item of items) {
    if (!(item instanceof ArtifactHandle)) {
      return items;
    }
    handles.push(item);
  }
  if (handles.length === 0) {
    return items;
  }
  return handles.sort((a, b) => compareStrings(a.hash, b.hash));
}

// Three parallel encodings of a node argument value: the hash form ({$artifact: <hash>}), the
// transport form ({__artifact__: ref}) sent to activities, and the input artifact ids for the ledger.
function encodeArgs(value: NodeArgValue): EncodedArgs {
  if (value instanceof ArtifactHandle) {
    return {
      hashForm: { $artifact: value.hash },
      transport: { __artifact__: { ...value.ref } },
      inputArtifactIds: [value.artifactId],
    };
  }
  if (Array.isArray(value)) {
    const encoded = sortedIfAllArtifacts(value).map(encodeArgs);
    return {
      hashForm: encoded.map((e) => e.hashForm),
      transport: encoded.map((e) => e.transport),
      inputArtifactIds: encoded.flatMap((e) => e.inputArtifactIds),
    };
  }
  if (value !== null && typeof value === 'object') {
    const hashForm: { [key: string]: JsonValue } = {};
    const transport: { [key: string]: TransportValue } = {};
    const inputArtifactIds: number[] = [];
    for (const [k, v] of Object.entries(value)) {
      const e = encodeArgs(v);
      hashForm[k] = e.hashForm;
      transport[k] = e.transport;
      inputArtifactIds.push(...e.inputArtifactIds);
    }
    return { hashForm, transport, inputArtifactIds };
  }
  return { hashForm: value, transport: value, inputArtifactIds: [] };
}

// Collect every ArtifactHandle inside an argument value — single handles, arrays, and nested
// containers — so the inputKinds check cannot be smuggled past by wrapping.
function collectHandles(value: NodeArgValue, out: ArtifactHandle[]): void {
  if (value instanceof ArtifactHandle) {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectHandles(item, out);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectHandles(item, out);
    }
  }
}

// Declared input ports, enforced before anything is hashed: a param mapped to a kind accepts only
// artifacts of that kind (single or list); a scalar param (null) accepts no artifacts. Absent
// params (nulled by the caller) pass vacuously. Exported for unit tests — Ctx.node's happy path
// requires a live activity proxy, but this guard is pure.
export function enforceInputKinds(nd: NodeDef, argMap: Record<string, NodeArgValue>): void {
  for (const p of nd.paramNames) {
    const expected = nd.inputKinds[p] ?? null;
    const handles: ArtifactHandle[] = [];
    collectHandles(argMap[p] ?? null, handles);
    if (expected === null) {
      if (handles.length > 0) {
        throw ApplicationFailure.nonRetryable(
          `node ${nd.nodeId}: param '${p}' is declared scalar but received an artifact of kind '${handles[0]?.kind ?? ''}'`
        );
      }
      continue;
    }
    for (const h of handles) {
      if (h.kind !== expected) {
        throw ApplicationFailure.nonRetryable(
          `node ${nd.nodeId}: param '${p}' expects kind '${expected}' but received '${h.kind}'`
        );
      }
    }
  }
}

const short = proxyActivities<Acts>({ startToCloseTimeout: '30s' });
const engineNode = proxyActivities<Acts>({
  startToCloseTimeout: '120s',
  retry: { maximumAttempts: 5, nonRetryableErrorTypes: ['NodeError'] },
});
const humanNode = proxyActivities<Acts>({
  startToCloseTimeout: '60s',
  retry: { maximumAttempts: 10, nonRetryableErrorTypes: ['NodeError'] },
});

export class Ctx {
  readonly engagementId: number;
  readonly workflowRunId: number;
  readonly workflowId: string;
  private readonly declared: Set<string>;
  private readonly attachments: ArtifactHandle[];
  private readonly registry: Registry;
  private readonly executed: string[] = [];
  private readonly memoHits: string[] = [];
  private readonly humanWaits: string[] = [];

  constructor(inp: RunInput, registry: Registry) {
    this.engagementId = inp.engagement_id;
    this.workflowRunId = inp.workflow_run_id;
    this.workflowId = inp.workflow_id;
    this.declared = new Set(inp.declared_kinds);
    this.attachments = inp.attachments.map((ref) => new ArtifactHandle(ref));
    this.registry = registry;
  }

  // User-sourced snapshot only (invariant I7), sorted by content hash.
  attached(kind: string): ArtifactHandle[] {
    if (!this.declared.has(kind)) {
      throw ApplicationFailure.nonRetryable(`kind '${kind}' is not declared by workflow '${this.workflowId}'`);
    }
    return this.attachments.filter((h) => h.kind === kind).sort((a, b) => compareStrings(a.hash, b.hash));
  }

  attachedOne(kind: string): ArtifactHandle {
    const items = this.attached(kind);
    const first = items[0];
    if (items.length !== 1 || first === undefined) {
      throw ApplicationFailure.nonRetryable(`expected exactly one '${kind}' attachment, found ${items.length}`);
    }
    return first;
  }

  attachedOneOrNone(kind: string): ArtifactHandle | null {
    const items = this.attached(kind);
    if (items.length > 1) {
      throw ApplicationFailure.nonRetryable(`expected at most one '${kind}' attachment, found ${items.length}`);
    }
    const first = items[0];
    return first === undefined ? null : first;
  }

  // Both spellings are public workflow-author API; the aliases delegate so overriding attached* covers both.
  userSupplied(kind: string): ArtifactHandle[] {
    return this.attached(kind);
  }

  userSuppliedOne(kind: string): ArtifactHandle {
    return this.attachedOne(kind);
  }

  userSuppliedOneOrNone(kind: string): ArtifactHandle | null {
    return this.attachedOneOrNone(kind);
  }

  // THE walk: input_hash over the canonical argument map, memo_key = H(node_id ':' input_hash),
  // lookup -> hit: reuse; miss: execute (engine activity, or human-task workflow + poll).
  async node(def: NodeDef, args: Record<string, NodeArgValue>): Promise<ArtifactHandle> {
    const nd = this.registry.tryNodeForWorkflow(this.workflowId, def.nodeId);
    if (nd === undefined) {
      throw ApplicationFailure.nonRetryable(
        `node '${def.nodeId}' is not registered for workflow '${this.workflowId}' (missing from its nodes list?)`
      );
    }
    const argMap: Record<string, NodeArgValue> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!nd.paramNames.includes(k)) {
        throw ApplicationFailure.nonRetryable(`unknown parameter '${k}' for node ${nd.nodeId}`);
      }
      if (v !== undefined) {
        argMap[k] = v;
      }
    }
    // Absent optional input: explicit null (rule 7) — the memo key covers ALL parameters, always.
    // Own-property semantics (`in` would see Object.prototype names) and undefined-as-absent, so
    // omitted, undefined, and explicit-null calls all produce the SAME memo key.
    for (const p of nd.paramNames) {
      if (!Object.hasOwn(argMap, p)) {
        argMap[p] = null;
      }
    }
    enforceInputKinds(nd, argMap);
    const { hashForm, transport, inputArtifactIds } = encodeArgs(argMap);
    const mk = memoKey(nd.nodeId, hashValue(hashForm));

    const hit = await short.memo_lookup(this.engagementId, mk);
    if (hit !== null) {
      this.memoHits.push(nd.nodeId);
      await this.attach(hit);
      return new ArtifactHandle(hit);
    }

    const req: NodeRequest = {
      engagement_id: this.engagementId,
      workflow_run_id: this.workflowRunId,
      workflow_id: this.workflowId,
      node_id: nd.nodeId,
      memo_key: mk,
      args_transport: transport,
      input_artifact_ids: inputArtifactIds,
    };

    if (nd.executor === 'engine') {
      const out = await engineNode.run_engine_node(req);
      (out.fresh ? this.executed : this.memoHits).push(nd.nodeId);
      if (!out.fresh) {
        // The fresh path's attachment already happened inside the completion tx.
        await this.attach(out.ref);
      }
      return new ArtifactHandle(out.ref);
    }

    // Human path: park the question, then poll the memo with capped exponential backoff
    // (sleep first; 1s -> x2 -> 30s cap).
    this.humanWaits.push(nd.nodeId);
    await humanNode.ensure_human_task(req);
    let delay = 1;
    let ref: ArtifactRef | null = null;
    while (ref === null) {
      await sleep(delay * 1000);
      delay = Math.min(delay * 2, 30);
      ref = await short.memo_lookup(this.engagementId, mk);
    }
    this.executed.push(nd.nodeId);
    await this.attach(ref);
    return new ArtifactHandle(ref);
  }

  summary(): Summary {
    return {
      workflow_run_id: this.workflowRunId,
      executed: this.executed,
      memo_hits: this.memoHits,
      human_waits: this.humanWaits,
    };
  }

  private async attach(ref: ArtifactRef): Promise<void> {
    await short.attach_artifact(this.workflowRunId, ref.artifact_id);
  }
}
