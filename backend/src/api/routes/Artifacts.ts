import { Buffer } from 'node:buffer';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { canonicalBytes } from '../../domain/canonical/Canonical.js';
import type { JsonValue } from '../../domain/json/JsonValue.js';
import {
  artifactLineage,
  attach,
  browseArtifacts,
  getArtifact,
  getEngagement,
  getWorkspace,
  renameArtifact,
  supplyArtifact,
} from '../../infrastructure/db/Db.js';
import { readPayload } from '../../infrastructure/storage/Storage.js';
import { errorMessage, ValidationError } from '../../shared/errors/Errors.js';
import type { ApiDeps } from '../Deps.js';
import { withConn } from '../Deps.js';
import {
  ArtifactIdParamsSchema,
  ArtifactPatchSchema,
  BrowseQuerySchema,
  EngagementIdParamsSchema,
} from '../Schemas.js';
import type { ArtifactMetaOut, NodeRunOut } from '../Serializers.js';
import { artifactMeta, nodeRunOut } from '../Serializers.js';

interface ValidationItem {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: string | Record<string, never>;
}

const missingField = (name: string): ValidationItem => ({
  type: 'missing',
  loc: ['body', name],
  msg: 'Field required',
  input: {},
});

// Browsers may send a full client path; strip POSIX then Windows directories, then the final .ext.
function filenameStem(filename: string): string {
  const posix = filename.slice(filename.lastIndexOf('/') + 1);
  const name = posix.slice(posix.lastIndexOf('\\') + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

// Header values must be latin-1 safe; collapse anything exotic to '_'.
function contentFilename(displayName: string | null, artifactId: number, mediaType: string): string {
  const cleaned = (displayName ?? '').replace(/[^A-Za-z0-9._ -]+/g, '_').replace(/^[ ._]+|[ ._]+$/g, '');
  const base = cleaned === '' ? `artifact_${artifactId}` : cleaned;
  const ext = mediaType === 'application/json' ? '.json' : '.txt';
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

interface UploadParts {
  data: Buffer | null;
  filename: string | null;
  contentType: string | null;
  fields: Map<string, string>;
}

async function readUploadParts(request: FastifyRequest): Promise<UploadParts> {
  const out: UploadParts = { data: null, filename: null, contentType: null, fields: new Map() };
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (part.fieldname === 'file' && out.data === null) {
        out.data = await part.toBuffer();
        out.filename = part.filename;
        out.contentType = part.mimetype;
      } else {
        await part.toBuffer();
      }
    } else if (typeof part.value === 'string') {
      out.fields.set(part.fieldname, part.value);
    }
  }
  return out;
}

// Questionnaire channel: the frontend is forbidden from producing canonical JSON, so with
// canonical_json=true the answers are parsed and canonicalized HERE — a re-answered identical
// questionnaire converges on the same artifact and revives downstream memo hits. Invalid JSON and
// non-canonicalizable values (floats etc.) surface as 422.
function canonicalizeIfRequested(parts: UploadParts, data: Uint8Array): { data: Uint8Array; mediaType: string } {
  const flag = (parts.fields.get('canonical_json') ?? '').toLowerCase();
  if (flag !== 'true' && flag !== '1') {
    return { data, mediaType: parts.contentType ?? 'application/octet-stream' };
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(Buffer.from(data).toString('utf8')) as JsonValue;
  } catch (e) {
    throw new ValidationError(`canonical_json upload is not valid JSON: ${errorMessage(e)}`);
  }
  return { data: canonicalBytes(parsed), mediaType: 'application/json' };
}

export function registerArtifactRoutes(app: FastifyInstance, deps: ApiDeps): void {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    '/engagements/:engagement_id/artifacts',
    { schema: { params: EngagementIdParamsSchema, querystring: BrowseQuerySchema } },
    async (request): Promise<ArtifactMetaOut[]> => {
      return withConn(deps, (conn) => {
        getEngagement(conn, request.params.engagement_id);
        const rows = browseArtifacts(conn, request.params.engagement_id, {
          nodeparamslot: request.query.nodeparamslot ?? null,
          q: request.query.q ?? null,
        });
        return rows.map(artifactMeta);
      });
    }
  );

  r.post(
    '/engagements/:engagement_id/artifacts',
    { schema: { params: EngagementIdParamsSchema } },
    async (request, reply): Promise<FastifyReply> => {
      const engagementId = request.params.engagement_id;
      const parts = await readUploadParts(request);

      const missing: ValidationItem[] = [];
      if (parts.data === null) {
        missing.push(missingField('file'));
      }
      if (!parts.fields.has('nodeparamslot')) {
        missing.push(missingField('nodeparamslot'));
      }
      if (missing.length > 0 || parts.data === null) {
        return reply.code(422).send({ detail: missing });
      }
      const { data, mediaType } = canonicalizeIfRequested(parts, parts.data);
      const nodeparamslot = parts.fields.get('nodeparamslot') ?? '';

      let workflowRunId: number | null = null;
      const rawWorkflowRunId = parts.fields.get('workflow_run_id');
      if (rawWorkflowRunId !== undefined && rawWorkflowRunId !== '') {
        const parsed = Number(rawWorkflowRunId);
        if (!Number.isSafeInteger(parsed)) {
          return reply.code(422).send({
            detail: [
              {
                type: 'int_parsing',
                loc: ['body', 'workflow_run_id'],
                msg: 'Input should be a valid integer, unable to parse string as an integer',
                input: rawWorkflowRunId,
              },
            ],
          });
        }
        workflowRunId = parsed;
      }

      let displayName = parts.fields.get('display_name') ?? null;
      if ((displayName === null || displayName === '') && parts.filename !== null && parts.filename !== '') {
        displayName = filenameStem(parts.filename);
      }

      const result = withConn(deps, (conn) => {
        getEngagement(conn, engagementId);
        if (nodeparamslot.trim() === '') {
          throw new ValidationError('nodeparamslot must be a non-empty string');
        }
        if (workflowRunId !== null) {
          const ws = getWorkspace(conn, workflowRunId);
          if (ws.engagement_id !== engagementId) {
            throw new ValidationError(`workflow_run ${workflowRunId} belongs to a different engagement`);
          }
        }
        const supplied = supplyArtifact(conn, deps.storageRoot, engagementId, nodeparamslot.trim(), data, {
          displayName,
          mediaType,
          createdBy: 'user',
        });
        if (workflowRunId !== null) {
          attach(conn, workflowRunId, supplied.artifact_id, { source: 'user', createdBy: 'user' });
        }
        return { artifact: artifactMeta(getArtifact(conn, supplied.artifact_id)), revived: supplied.existed };
      });
      return reply.send(result);
    }
  );

  r.get(
    '/artifacts/:artifact_id',
    { schema: { params: ArtifactIdParamsSchema } },
    async (
      request
    ): Promise<{ artifact: ArtifactMetaOut; produced_by: NodeRunOut | null; consumed_by: NodeRunOut[] }> => {
      return withConn(deps, (conn) => {
        const art = getArtifact(conn, request.params.artifact_id);
        const lineage = artifactLineage(conn, art.artifact_id);
        return {
          artifact: artifactMeta(art),
          produced_by: lineage.produced_by === null ? null : nodeRunOut(conn, lineage.produced_by),
          consumed_by: lineage.consumed_by.map((run) => nodeRunOut(conn, run)),
        };
      });
    }
  );

  r.get(
    '/artifacts/:artifact_id/content',
    { schema: { params: ArtifactIdParamsSchema } },
    async (request, reply): Promise<FastifyReply> => {
      const found = withConn(deps, (conn) => {
        const art = getArtifact(conn, request.params.artifact_id);
        return { art, payloadRef: art.payload_ref };
      });
      if (found.payloadRef === null) {
        return reply.code(410).send({ detail: 'payload destroyed per policy' });
      }
      const data = readPayload(deps.storageRoot, found.payloadRef);
      const name = contentFilename(found.art.display_name, found.art.artifact_id, found.art.media_type);
      return reply
        .header('content-disposition', `attachment; filename="${name}"`)
        .type(found.art.media_type)
        .send(Buffer.from(data));
    }
  );

  r.patch(
    '/artifacts/:artifact_id',
    { schema: { params: ArtifactIdParamsSchema, body: ArtifactPatchSchema } },
    async (request): Promise<{ artifact: ArtifactMetaOut }> => {
      return withConn(deps, (conn) => {
        getArtifact(conn, request.params.artifact_id);
        renameArtifact(conn, request.params.artifact_id, request.body.display_name, 'user');
        return { artifact: artifactMeta(getArtifact(conn, request.params.artifact_id)) };
      });
    }
  );
}
