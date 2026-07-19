// Explicit workflow manifest: one line per workflow version. Only the check-workflows script
// (npm run check:workflows) enforces that every src/workflows/<workflow_id>/ folder is listed
// here — publish never reads the filesystem, so an unlisted folder silently never publishes.
import type { WorkflowDef } from '../domain/registry/Registry.js';
import { taxDemoWorkflow } from './tax_demo_workflow/workflow.js';
import { taxDemoWorkflowV2 } from './tax_demo_workflow_v2/workflow.js';

export const ALL_WORKFLOWS: readonly WorkflowDef[] = [taxDemoWorkflow, taxDemoWorkflowV2];
