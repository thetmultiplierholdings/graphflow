// Name-discipline check for the workflows layout (the surviving half of the old code-hash
// codegen): under name identity the folder name IS the workflow version. A workflow folder is a
// directory under src/workflows/ containing a workflow.ts; directories without one (e.g.
// nodes_shared/) are shared-code libraries and are ignored. Every workflow id in ALL_WORKFLOWS
// must own a workflow folder of the same name, and every workflow folder must be listed in the
// manifest — an unlisted folder is a workflow that silently never publishes.
//
// One node, one file, file name == node_id: every node in the manifest must own
// nodes_shared/<node_id>.ts (version-spanning) or <workflow_id>/nodes_special/<node_id>.ts.
// Existence-only by design (the source-parsing codegen is gone): a node redefined inline in
// workflow.ts while a same-named stale file lingers would pass — trusted to review, like the
// rest of the naming contract.
//
// Usage: npm run check:workflows

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError, ValidationError } from '../src/shared/errors/Errors.js';
import { ALL_WORKFLOWS } from '../src/workflows/index.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowsDir = join(packageRoot, 'src', 'workflows');

function main(): void {
  const workflowFolders = readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(workflowsDir, entry.name, 'workflow.ts')))
    .map((entry) => entry.name)
    .sort();

  const manifestIds = new Set(ALL_WORKFLOWS.map((wd) => wd.workflowId));
  for (const wd of ALL_WORKFLOWS) {
    if (!workflowFolders.includes(wd.workflowId)) {
      throw new ValidationError(
        `workflow id '${wd.workflowId}' has no src/workflows/${wd.workflowId}/workflow.ts (the folder name IS the version)`
      );
    }
  }
  for (const folder of workflowFolders) {
    if (!manifestIds.has(folder)) {
      throw new RuntimeError(
        `workflow folder 'src/workflows/${folder}/' is not listed in ALL_WORKFLOWS (src/workflows/index.ts)`
      );
    }
  }
  let nodeFiles = 0;
  for (const wd of ALL_WORKFLOWS) {
    for (const nd of wd.nodes) {
      const shared = join(workflowsDir, 'nodes_shared', `${nd.nodeId}.ts`);
      const special = join(workflowsDir, wd.workflowId, 'nodes_special', `${nd.nodeId}.ts`);
      if (!(existsSync(shared) || existsSync(special))) {
        throw new ValidationError(
          `node '${wd.workflowId}/${nd.nodeId}' has no file — expected src/workflows/nodes_shared/${nd.nodeId}.ts or src/workflows/${wd.workflowId}/nodes_special/${nd.nodeId}.ts (one node per file, file name == node_id)`
        );
      }
      nodeFiles += 1;
    }
  }
  process.stdout.write(
    `checked ${ALL_WORKFLOWS.length} workflow folder(s) and ${nodeFiles} node declaration(s): ids match folders, one node per file, manifest complete\n`
  );
}

main();
