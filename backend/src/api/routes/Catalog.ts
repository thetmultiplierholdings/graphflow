import type { FastifyInstance } from 'fastify';
import { catalogSnapshot } from '../../infrastructure/db/Db.js';
import type { ApiDeps } from '../Deps.js';
import { withConn } from '../Deps.js';
import type { CatalogOut } from '../Schemas.js';

const VERSION_RE = /^(.+)_v(\d+)$/;

// Strip a trailing _v{n}; no suffix == version 1.
function family(workflowId: string): { stem: string; version: number } {
  const m = VERSION_RE.exec(workflowId);
  if (m === null) {
    return { stem: workflowId, version: 1 };
  }
  return { stem: m[1], version: Number(m[2]) };
}

// The highest (version, workflow_id) member of each family gets superseded_by: null; every other
// member points at it. Derived purely from the workflow_id naming convention (the id is the
// workflow's folder name under src/workflows/).
function supersededMap(workflowIds: readonly string[]): Record<string, string | null> {
  const families = new Map<string, { version: number; wid: string }[]>();
  for (const wid of workflowIds) {
    const { stem, version } = family(wid);
    const members = families.get(stem) ?? [];
    members.push({ version, wid });
    families.set(stem, members);
  }
  const out: Record<string, string | null> = {};
  for (const members of families.values()) {
    let current = members[0];
    for (const m of members) {
      if (m.version > current.version || (m.version === current.version && m.wid > current.wid)) {
        current = m;
      }
    }
    for (const m of members) {
      out[m.wid] = m.wid === current.wid ? null : current.wid;
    }
  }
  return out;
}

export function registerCatalogRoutes(app: FastifyInstance, deps: ApiDeps): void {
  app.get('/catalog', async (): Promise<CatalogOut> => {
    const snapshot = withConn(deps, (conn) => catalogSnapshot(conn));
    const superseded = supersededMap(snapshot.map((wf) => wf.workflow_id));
    return {
      workflows: snapshot.map((wf) => ({
        workflow_id: wf.workflow_id,
        display_name: wf.display_name,
        created_at: wf.created_at,
        updated_at: wf.updated_at,
        superseded_by: superseded[wf.workflow_id] ?? null,
        nodeparamslots: wf.nodeparamslots.map((k) => ({
          nodeparamslot: k.nodeparamslot,
          display_name: k.display_name,
          source: k.source,
          leaf: k.leaf !== 0,
        })),
        nodes: wf.nodes.map((n) => ({
          node_id: n.node_id,
          display_name: n.display_name,
          executor: n.executor,
          output_nodeparamslot: n.output_nodeparamslot,
          input_nodeparamslots: n.input_nodeparamslots,
        })),
      })),
    };
  });
}
