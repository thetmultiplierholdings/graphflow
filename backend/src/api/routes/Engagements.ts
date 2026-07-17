import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { createEngagement, getEngagement, listEngagements, listNodeRuns } from '../../infrastructure/db/Db.js';
import type { ApiDeps } from '../Deps.js';
import { withConn } from '../Deps.js';
import { EngagementCreateSchema, EngagementIdParamsSchema } from '../Schemas.js';
import type { EngagementOut, NodeRunOut } from '../Serializers.js';
import { engagementOut, nodeRunOut } from '../Serializers.js';

export function registerEngagementRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/engagements', async (): Promise<EngagementOut[]> => {
    return withConn(deps, (conn) => listEngagements(conn).map((row) => engagementOut(conn, row)));
  });

  r.post('/engagements', { schema: { body: EngagementCreateSchema } }, async (request): Promise<EngagementOut> => {
    return withConn(deps, (conn) => {
      const engagementId = createEngagement(conn, request.body.label);
      return engagementOut(conn, getEngagement(conn, engagementId));
    });
  });

  r.get(
    '/engagements/:engagement_id',
    { schema: { params: EngagementIdParamsSchema } },
    async (request): Promise<EngagementOut> => {
      return withConn(deps, (conn) => engagementOut(conn, getEngagement(conn, request.params.engagement_id)));
    }
  );

  r.get(
    '/engagements/:engagement_id/node-runs',
    { schema: { params: EngagementIdParamsSchema } },
    async (request): Promise<NodeRunOut[]> => {
      return withConn(deps, (conn) => {
        getEngagement(conn, request.params.engagement_id);
        return listNodeRuns(conn, request.params.engagement_id).map((run) => nodeRunOut(conn, run));
      });
    }
  );
}
