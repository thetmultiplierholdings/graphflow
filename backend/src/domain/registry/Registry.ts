import { RuntimeError, ValidationError } from '../../shared/errors/Errors.js';
import type { Ctx } from '../../temporal/Context.js';
import type { ArtifactHandle } from '../artifact/ArtifactHandle.js';
import type { JsonValue } from '../json/JsonValue.js';

// Config-object factories for node, human-node, and workflow definitions, plus the registry built
// from the explicit workflows manifest. Pure and bundle-safe—imported by Temporal workflow code,
// so no node:* imports here.

export interface Kind {
  kind: string;
  display?: string;
}

export type NodeArgValue = JsonValue | ArtifactHandle | NodeArgValue[] | { [key: string]: NodeArgValue };

export interface HumanTask {
  instructions: string;
  payload: Record<string, NodeArgValue>;
  resultRequiredKeys: string[];
}

export type Executor = 'engine' | 'human';
export type Dedupe = 'none' | 'hard';

// Function deps are hashed by authored source text (build-time codegen); constants by canonical JSON.
export type HashDep = ((...args: never[]) => unknown) | JsonValue;

export type NodeResult = JsonValue | string | Uint8Array | HumanTask;

export interface NodeDef<P extends Record<string, NodeArgValue> = Record<string, NodeArgValue>, R = NodeResult> {
  readonly nodeId: string;
  readonly executor: Executor;
  readonly outputKind: string;
  readonly paramNames: readonly string[];
  readonly hashWith: readonly HashDep[];
  readonly codeSalt: string;
  readonly dedupe: Dedupe;
  readonly displayName: string;
  readonly resultValidator?: (result: Record<string, JsonValue>) => void;
  // Method syntax (not a property) is deliberate: it keeps concrete NodeDef<{...}> assignable to
  // the bare NodeDef stored in WorkflowDef.nodes; the engine re-checks args at runtime via paramNames.
  run(args: P): R | Promise<R>;
}

export interface WorkflowDef {
  readonly workflowId: string;
  readonly kinds: readonly Kind[];
  readonly displayName: string;
  readonly nodes: readonly NodeDef[];
  readonly run: (ctx: Ctx) => Promise<void>;
}

export interface NodeConfig<P extends Record<string, NodeArgValue>, R> {
  name: string;
  outputKind: string;
  params: readonly (keyof P & string)[];
  hashWith?: readonly HashDep[];
  codeSalt?: string;
  dedupe?: Dedupe;
  displayName?: string;
  run: (args: P) => R | Promise<R>;
}

export interface HumanNodeConfig<P extends Record<string, NodeArgValue>> {
  name: string;
  outputKind: string;
  params: readonly (keyof P & string)[];
  title?: string;
  hashWith?: readonly HashDep[];
  codeSalt?: string;
  resultValidator?: (result: Record<string, JsonValue>) => void;
  run: (args: P) => HumanTask | Promise<HumanTask>;
}

export interface WorkflowConfig {
  id: string;
  kinds: readonly Kind[];
  displayName?: string;
  nodes: readonly NodeDef[];
  run: (ctx: Ctx) => Promise<void>;
}

export function defineNode<P extends Record<string, NodeArgValue>, R>(cfg: NodeConfig<P, R>): NodeDef<P, R> {
  const def: NodeDef<P, R> = {
    nodeId: cfg.name,
    executor: 'engine',
    outputKind: cfg.outputKind,
    paramNames: Object.freeze([...cfg.params]),
    hashWith: Object.freeze([...(cfg.hashWith ?? [])]),
    codeSalt: cfg.codeSalt ?? '',
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
    outputKind: cfg.outputKind,
    paramNames: Object.freeze([...cfg.params]),
    hashWith: Object.freeze([...(cfg.hashWith ?? [])]),
    codeSalt: cfg.codeSalt ?? '',
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
    kinds: Object.freeze([...cfg.kinds]),
    displayName: cfg.displayName ?? cfg.id.replaceAll('_', ' '),
    nodes: Object.freeze([...cfg.nodes]),
    run: cfg.run,
  };
  return Object.freeze(def);
}

// leaf = true iff no node in the workflow produces that kind; order follows the kinds declaration.
export function leafKinds(wd: WorkflowDef): Record<string, boolean> {
  const produced = new Set(wd.nodes.map((node) => node.outputKind));
  const out: Record<string, boolean> = {};
  for (const kind of wd.kinds) {
    out[kind.kind] = !produced.has(kind.kind);
  }
  return out;
}

export interface RegisteredNode {
  readonly def: NodeDef;
  readonly codeHash: string;
}

export interface Registry {
  readonly workflows: ReadonlyMap<string, WorkflowDef>;
  nodeForWorkflow(workflowId: string, nodeId: string): RegisteredNode;
  tryNodeForWorkflow(workflowId: string, nodeId: string): RegisteredNode | undefined;
}

const registryKey = (workflowId: string, nodeId: string): string => `${workflowId}:${nodeId}`;

export function buildRegistry(all: readonly WorkflowDef[], codeHashes: Readonly<Record<string, string>>): Registry {
  const workflows = new Map<string, WorkflowDef>();
  const registered = new Map<string, RegisteredNode>();
  for (const wd of all) {
    if (workflows.has(wd.workflowId)) {
      throw new ValidationError(`duplicate workflow_id '${wd.workflowId}'`);
    }
    for (const nd of wd.nodes) {
      const key = registryKey(wd.workflowId, nd.nodeId);
      const codeHash = codeHashes[key];
      if (codeHash === undefined) {
        throw new RuntimeError(`no code hash for ${key} — run 'npm run gen:hashes'`);
      }
      registered.set(key, Object.freeze({ def: nd, codeHash }));
    }
    workflows.set(wd.workflowId, wd);
  }
  return {
    workflows,
    nodeForWorkflow(workflowId: string, nodeId: string): RegisteredNode {
      const node = registered.get(registryKey(workflowId, nodeId));
      if (node === undefined) {
        throw new RuntimeError(`unknown node ${workflowId}:${nodeId}`);
      }
      return node;
    },
    tryNodeForWorkflow(workflowId: string, nodeId: string): RegisteredNode | undefined {
      return registered.get(registryKey(workflowId, nodeId));
    },
  };
}
