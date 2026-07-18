import { existsSync } from 'node:fs';
import { z } from 'zod';
import { ValidationError } from '../../shared/errors/Errors.js';

export interface Env {
  temporalAddress: string;
  temporalNamespace: string;
  temporalApiKey: string | undefined;
  temporalTaskQueue: string;
  dbPath: string;
  storageRoot: string;
  embedWorker: boolean;
  corsOrigins: string[];
  host: string;
  port: number;
}

// TEMPORAL_* defaults target a local dev Temporal server, so a bare `cli init` works without a .env.
const EnvSchema = z.object({
  TEMPORAL_ADDRESS: z.string().min(1).default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),
  TEMPORAL_TASK_QUEUE: z.string().min(1).default('thet-temporal-dev-ignore'),
  TEMPORAL_API_KEY: z.string().optional(),
  GRAPHFLOW_DB: z.string().default('graphflow.sqlite3'),
  GRAPHFLOW_STORAGE: z.string().default('mock_s3_gcs'),
  GRAPHFLOW_EMBED_WORKER: z.string().default('1'),
  GRAPHFLOW_CORS_ORIGINS: z.string().default('http://localhost:3000'),
  // Loopback by default; 0.0.0.0 exposes the unauthenticated API to the network.
  GRAPHFLOW_HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().default(8000),
});

export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new ValidationError(`invalid environment: ${issues}`);
  }
  const env = parsed.data;
  return {
    temporalAddress: env.TEMPORAL_ADDRESS,
    temporalNamespace: env.TEMPORAL_NAMESPACE,
    // An empty TEMPORAL_API_KEY means unset: connect plain non-TLS instead of failing auth.
    temporalApiKey: env.TEMPORAL_API_KEY === '' ? undefined : env.TEMPORAL_API_KEY,
    temporalTaskQueue: env.TEMPORAL_TASK_QUEUE,
    dbPath: env.GRAPHFLOW_DB,
    storageRoot: env.GRAPHFLOW_STORAGE,
    embedWorker: env.GRAPHFLOW_EMBED_WORKER !== '0',
    corsOrigins: env.GRAPHFLOW_CORS_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== ''),
    host: env.GRAPHFLOW_HOST,
    port: env.PORT,
  };
}

// Shell env always wins: process.loadEnvFile never overrides variables already set.
export function loadEnv(): Env {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }
  return parseEnv(process.env);
}
