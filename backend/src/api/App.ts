import { fastifyCors } from '@fastify/cors';
import { fastifyMultipart } from '@fastify/multipart';
import type { FastifyBaseLogger, FastifyError, FastifyInstance } from 'fastify';
import { fastify } from 'fastify';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { JsonValue } from '../domain/json/JsonValue.js';
import { JsonValueSchema } from '../domain/json/JsonValue.js';
import { NotFoundError, RuntimeError, ValidationError } from '../shared/errors/Errors.js';
import type { ApiDeps } from './Deps.js';
import { registerArtifactRoutes } from './routes/Artifacts.js';
import { registerCatalogRoutes } from './routes/Catalog.js';
import { registerEngagementRoutes } from './routes/Engagements.js';
import { registerHumanTaskRoutes } from './routes/HumanTasks.js';
import { registerWorkflowRunRoutes } from './routes/WorkflowRuns.js';

export interface BuildAppOptions {
  loggerInstance?: FastifyBaseLogger;
}

interface ValidationDetailItem {
  type: string;
  loc: (string | number)[];
  msg: string;
  input: JsonValue;
}

// Validation locs in the error envelope use "path"/"query"; fastify's validationContext says
// "params"/"querystring", so map before building the detail array.
const locPrefix = (context: string | undefined): string => {
  if (context === 'params') {
    return 'path';
  }
  if (context === 'querystring') {
    return 'query';
  }
  return context ?? 'body';
};

const INDEX_SEGMENT_RE = /^\d+$/;

const pathSegments = (instancePath: string): (string | number)[] =>
  instancePath
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => (INDEX_SEGMENT_RE.test(segment) ? Number(segment) : segment));

export async function buildApp(deps: ApiDeps, opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  // JSON bodyLimit matches the multipart fileSize cap; Fastify's 1 MiB default would reject
  // large-but-legitimate reviewer submissions.
  const bodyLimit = 50 * 1024 * 1024;
  const app =
    opts.loggerInstance === undefined
      ? fastify({ logger: false, bodyLimit })
      : fastify({ loggerInstance: opts.loggerInstance, bodyLimit });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifyCors, {
    origin: deps.env.corsOrigins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(fastifyMultipart, { limits: { fileSize: bodyLimit } });

  registerCatalogRoutes(app, deps);
  registerEngagementRoutes(app, deps);
  registerArtifactRoutes(app, deps);
  registerWorkflowRunRoutes(app, deps);
  registerHumanTaskRoutes(app, deps);

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.code(404).send({ detail: 'Not Found' });
  });

  // The error envelope is always { detail: ... } — string for domain/HTTPException-style errors,
  // array for request-validation failures (the frontend branches on string-vs-array only).
  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    // FastifyError is an interface; re-type through Error so instanceof narrows to our classes.
    const err: Error = error;
    if (err instanceof ValidationError) {
      return reply.code(422).send({ detail: err.message });
    }
    if (err instanceof NotFoundError) {
      return reply.code(404).send({ detail: err.message });
    }
    if (err instanceof RuntimeError) {
      const code = err.context?.code === 'SNAPSHOT_CHANGED' ? 409 : 422;
      return reply.code(code).send({ detail: err.message });
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const where = locPrefix(error.validationContext);
      const detail: ValidationDetailItem[] = error.validation.map((issue) => ({
        type: issue.keyword,
        loc: [where, ...pathSegments(issue.instancePath)],
        msg: issue.message ?? 'Invalid input',
        input: JsonValueSchema.safeParse(issue.params.input).data ?? null,
      }));
      return reply.code(422).send({ detail });
    }
    // Fastify 5 wraps JSON parse failures in FST_ERR_CTP_INVALID_JSON_BODY (not a SyntaxError).
    if (
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error instanceof SyntaxError
    ) {
      return reply.code(422).send({
        detail: [
          {
            type: 'json_invalid',
            loc: ['body', 0],
            msg: 'JSON decode error',
            input: {},
            ctx: { error: error.message },
          },
        ],
      });
    }
    if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ detail: error.message });
    }
    request.log.error({ err: error }, 'unhandled API error');
    return reply.code(500).send({ detail: 'Internal Server Error' });
  });

  return app;
}
