import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import type { Ctx } from '../../temporal/Context.js';
import type { ArtifactHandle } from '../artifact/ArtifactHandle.js';
import type { JsonValue } from '../json/JsonValue.js';

// Config-object factories for node, human-node, and workflow definitions, plus the registry built
// from the explicit workflows manifest. Pure and bundle-safe—imported by Temporal workflow code,
// so no node:* imports here.

// The birth channel of a nodeparamslot: upload/questionnaire/email are leaf channels (reality enters
// through them); computed nodeparamslots are born from nodes. Authored per declaration, reconciled against
// the derived class (nodeparamslotClasses) by validateCatalog.
export type NodeparamslotSource = 'upload' | 'questionnaire' | 'email' | 'computed';

export interface Nodeparamslot {
  nodeparamslot: string;
  source: NodeparamslotSource;
  display?: string;
  // A computed nodeparamslot with no producing node in this workflow is normally a publish error; intake
  // declares it as another workflow's output attached as input (legal membership, not a mistake).
  intake?: true;
}

export type NodeArgValue = JsonValue | ArtifactHandle | NodeArgValue[] | { [key: string]: NodeArgValue };

export interface HumanTask {
  instructions: string;
  payload: Record<string, NodeArgValue>;
  resultRequiredKeys: string[];
}

export type Executor = 'engine' | 'human';
export type Dedupe = 'none' | 'hard';

export type NodeResult = JsonValue | string | Uint8Array | HumanTask;

// Every param maps to the artifact nodeparamslot it consumes, or null for a scalar (non-artifact) argument.
export type InputNodeparamslots = Readonly<Record<string, string | null>>;

export interface NodeDef<P extends Record<string, NodeArgValue> = Record<string, NodeArgValue>, R = NodeResult> {
  readonly nodeId: string;
  readonly executor: Executor;
  readonly outputNodeparamslot: string;
  // Derived: Object.keys(inputNodeparamslots) in declaration order — inputNodeparamslots is the single source of truth.
  readonly paramNames: readonly string[];
  readonly inputNodeparamslots: InputNodeparamslots;
  readonly dedupe: Dedupe;
  readonly displayName: string;
  readonly resultValidator?: (result: Record<string, JsonValue>) => void;
  // Method syntax (not a property) is deliberate: it keeps concrete NodeDef<{...}> assignable to
  // the bare NodeDef stored in WorkflowDef.nodes; the engine re-checks args at runtime via paramNames.
  run(args: P): R | Promise<R>;
}

export interface WorkflowDef {
  readonly workflowId: string;
  readonly nodeparamslots: readonly Nodeparamslot[];
  readonly displayName: string;
  readonly nodes: readonly NodeDef[];
  readonly run: (ctx: Ctx) => Promise<void>;
}

export interface NodeConfig<P extends Record<string, NodeArgValue>, R> {
  name: string;
  outputNodeparamslot: string;
  // THE parameter declaration — an entry is a param: its key is the name (key insertion order is
  // the declared order), its value the consumed artifact nodeparamslot, or null for a scalar argument.
  // Total by construction: the mapped key forces an entry per key of P at compile time.
  inputNodeparamslots: Readonly<Record<keyof P & string, string | null>>;
  dedupe?: Dedupe;
  displayName?: string;
  run: (args: P) => R | Promise<R>;
}

export interface HumanNodeConfig<P extends Record<string, NodeArgValue>> {
  name: string;
  outputNodeparamslot: string;
  inputNodeparamslots: Readonly<Record<keyof P & string, string | null>>;
  title?: string;
  resultValidator?: (result: Record<string, JsonValue>) => void;
  run: (args: P) => HumanTask | Promise<HumanTask>;
}

export interface WorkflowConfig {
  id: string;
  nodeparamslots: readonly Nodeparamslot[];
  displayName?: string;
  nodes: readonly NodeDef[];
  run: (ctx: Ctx) => Promise<void>;
}

export function defineNode<P extends Record<string, NodeArgValue>, R>(cfg: NodeConfig<P, R>): NodeDef<P, R> {
  const def: NodeDef<P, R> = {
    nodeId: cfg.name,
    executor: 'engine',
    outputNodeparamslot: cfg.outputNodeparamslot,
    paramNames: Object.freeze(Object.keys(cfg.inputNodeparamslots)),
    inputNodeparamslots: Object.freeze({ ...cfg.inputNodeparamslots }),
    dedupe: cfg.dedupe ?? 'none',
    displayName: cfg.displayName ?? cfg.name.replaceAll('_', ' '),
    run: cfg.run,
  };
  return Object.freeze(def);
}

export function defineHumanNode<P extends Record<string, NodeArgValue>>(
  cfg: HumanNodeConfig<P>
): NodeDef<P, HumanTask> {
  const def: NodeDef<P, HumanTask> = {
    nodeId: cfg.name,
    executor: 'human',
    outputNodeparamslot: cfg.outputNodeparamslot,
    paramNames: Object.freeze(Object.keys(cfg.inputNodeparamslots)),
    inputNodeparamslots: Object.freeze({ ...cfg.inputNodeparamslots }),
    dedupe: 'hard',
    displayName: cfg.title ?? cfg.name.replaceAll('_', ' '),
    resultValidator: cfg.resultValidator,
    run: cfg.run,
  };
  return Object.freeze(def);
}

export function defineWorkflow(cfg: WorkflowConfig): WorkflowDef {
  const seen = new Set<string>();
  for (const node of cfg.nodes) {
    if (seen.has(node.nodeId)) {
      throw new ValidationError(`duplicate node_id '${node.nodeId}' in ${cfg.id}`);
    }
    seen.add(node.nodeId);
  }
  const def: WorkflowDef = {
    workflowId: cfg.id,
    nodeparamslots: Object.freeze([...cfg.nodeparamslots]),
    displayName: cfg.displayName ?? cfg.id.replaceAll('_', ' '),
    nodes: Object.freeze([...cfg.nodes]),
    run: cfg.run,
  };
  return Object.freeze(def);
}

// Derived, never authored: a nodeparamslot is computed iff some node in the workflow produces it; leafness
// is a theorem over the graph. Order follows the nodeparamslots declaration.
export function nodeparamslotClasses(wd: WorkflowDef): Record<string, 'leaf' | 'computed'> {
  const produced = new Set(wd.nodes.map((node) => node.outputNodeparamslot));
  const out: Record<string, 'leaf' | 'computed'> = {};
  for (const nodeparamslot of wd.nodeparamslots) {
    out[nodeparamslot.nodeparamslot] = produced.has(nodeparamslot.nodeparamslot) ? 'computed' : 'leaf';
  }
  return out;
}

type GlobalNodeparamslotDecl = { workflowId: string; source: NodeparamslotSource; display: string };
type GlobalNodeDecl = { workflowId: string; signature: string };

// One workflow's nodeparamslot declarations: unique within the workflow, consistent with every other
// workflow's declaration of the same nodeparamslot (the global nodeparamslots table cannot hold two truths).
function checkNodeparamslotDeclarations(
  wd: WorkflowDef,
  globalNodeparamslots: Map<string, GlobalNodeparamslotDecl>
): Map<string, Nodeparamslot> {
  const declared = new Map<string, Nodeparamslot>();
  for (const k of wd.nodeparamslots) {
    if (declared.has(k.nodeparamslot)) {
      throw new ValidationError(`${wd.workflowId}: nodeparamslot '${k.nodeparamslot}' declared twice`);
    }
    declared.set(k.nodeparamslot, k);
    const prior = globalNodeparamslots.get(k.nodeparamslot);
    if (prior === undefined) {
      globalNodeparamslots.set(k.nodeparamslot, {
        workflowId: wd.workflowId,
        source: k.source,
        display: k.display ?? '',
      });
    } else if (prior.source !== k.source || prior.display !== (k.display ?? '')) {
      throw new ValidationError(
        `nodeparamslot '${k.nodeparamslot}': ${wd.workflowId} declares source '${k.source}'/display '${k.display ?? ''}' but ${prior.workflowId} declared '${prior.source}'/'${prior.display}'`
      );
    }
  }
  return declared;
}

// One node: nodeparamslots it touches must be declared; a node name shared across workflows must declare
// the same shape — the mechanical remnant of the dead code-hash tripwire.
function checkNode(
  wd: WorkflowDef,
  nd: NodeDef,
  declared: Map<string, Nodeparamslot>,
  globalNodes: Map<string, GlobalNodeDecl>
): void {
  if (!declared.has(nd.outputNodeparamslot)) {
    throw new ValidationError(
      `${wd.workflowId}/${nd.nodeId}: output nodeparamslot '${nd.outputNodeparamslot}' is not declared by the workflow`
    );
  }
  for (const [param, nodeparamslot] of Object.entries(nd.inputNodeparamslots)) {
    if (nodeparamslot !== null && !declared.has(nodeparamslot)) {
      throw new ValidationError(
        `${wd.workflowId}/${nd.nodeId}: param '${param}' consumes nodeparamslot '${nodeparamslot}' which is not declared by the workflow`
      );
    }
  }
  const signature = JSON.stringify({
    executor: nd.executor,
    outputNodeparamslot: nd.outputNodeparamslot,
    paramNames: nd.paramNames,
    inputNodeparamslots: nd.inputNodeparamslots,
    displayName: nd.displayName,
  });
  const prior = globalNodes.get(nd.nodeId);
  if (prior === undefined) {
    globalNodes.set(nd.nodeId, { workflowId: wd.workflowId, signature });
  } else if (prior.signature !== signature) {
    throw new ValidationError(
      `node '${nd.nodeId}' is declared with a different shape in ${wd.workflowId} than in ${prior.workflowId} — under name identity that shares memo answers across divergent behavior; rename one`
    );
  }
}

// Authored source vs derived class: a produced nodeparamslot must be authored computed; an unproduced
// computed nodeparamslot must be declared intake (another workflow's output attached as input).
function reconcileNodeparamslotClasses(wd: WorkflowDef, declared: Map<string, Nodeparamslot>): void {
  for (const [nodeparamslot, cls] of Object.entries(nodeparamslotClasses(wd))) {
    const decl = declared.get(nodeparamslot);
    if (decl === undefined) {
      continue;
    }
    if (cls === 'computed' && decl.source !== 'computed') {
      throw new ValidationError(
        `${wd.workflowId}: nodeparamslot '${nodeparamslot}' is produced by a node but declared with leaf source '${decl.source}'`
      );
    }
    if (cls === 'leaf' && decl.source === 'computed' && decl.intake !== true) {
      throw new ValidationError(
        `${wd.workflowId}: computed nodeparamslot '${nodeparamslot}' has no producing node — declare intake: true if it arrives from another workflow`
      );
    }
  }
}

// Publish hygiene: pure validation over the in-memory registry, run before any catalog write.
export function validateCatalog(all: readonly WorkflowDef[]): void {
  const globalNodeparamslots = new Map<string, GlobalNodeparamslotDecl>();
  const globalNodes = new Map<string, GlobalNodeDecl>();
  for (const wd of all) {
    const declared = checkNodeparamslotDeclarations(wd, globalNodeparamslots);
    for (const nd of wd.nodes) {
      checkNode(wd, nd, declared, globalNodes);
    }
    reconcileNodeparamslotClasses(wd, declared);
  }
}

export interface Registry {
  readonly workflows: ReadonlyMap<string, WorkflowDef>;
  nodeForWorkflow(workflowId: string, nodeId: string): NodeDef;
  tryNodeForWorkflow(workflowId: string, nodeId: string): NodeDef | undefined;
}

const registryKey = (workflowId: string, nodeId: string): string => `${workflowId}:${nodeId}`;

export function buildRegistry(all: readonly WorkflowDef[]): Registry {
  const workflows = new Map<string, WorkflowDef>();
  const registered = new Map<string, NodeDef>();
  for (const wd of all) {
    if (workflows.has(wd.workflowId)) {
      throw new ValidationError(`duplicate workflow_id '${wd.workflowId}'`);
    }
    for (const nd of wd.nodes) {
      registered.set(registryKey(wd.workflowId, nd.nodeId), nd);
    }
    workflows.set(wd.workflowId, wd);
  }
  return {
    workflows,
    nodeForWorkflow(workflowId: string, nodeId: string): NodeDef {
      const node = registered.get(registryKey(workflowId, nodeId));
      if (node === undefined) {
        throw new RuntimeError(`unknown node ${workflowId}:${nodeId}`);
      }
      return node;
    },
    tryNodeForWorkflow(workflowId: string, nodeId: string): NodeDef | undefined {
      return registered.get(registryKey(workflowId, nodeId));
    },
  };
}
