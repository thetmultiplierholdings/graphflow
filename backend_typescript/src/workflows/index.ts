// Explicit workflow manifest: one line per workflow version; the codegen and publish steps
// enforce that every workflows/*.ts file is listed here.
import type { WorkflowDef } from '../domain/registry/Registry.js';
import { taxDemoWorkflow } from './tax_demo_workflow.js';
import { taxDemoWorkflowV2 } from './tax_demo_workflow_v2.js';

export const ALL_WORKFLOWS: readonly WorkflowDef[] = [taxDemoWorkflow, taxDemoWorkflowV2];
