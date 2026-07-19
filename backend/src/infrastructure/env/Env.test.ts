import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../shared/errors/Errors.js';
import { parseEnv } from './Env.js';

const REQUIRED = {
  TEMPORAL_ADDRESS: 'my-ns.a1b2c.tmprl.cloud:7233',
  TEMPORAL_NAMESPACE: 'my-ns.a1b2c',
  TEMPORAL_TASK_QUEUE: 'graphflow-queue',
};

describe('parseEnv', () => {
  it('parses a fully specified environment', () => {
    const env = parseEnv({
      ...REQUIRED,
      TEMPORAL_API_KEY: 'not-a-real-key',
      GRAPHFLOW_DB: '/tmp/scratch.sqlite3',
      GRAPHFLOW_STORAGE: '/tmp/storage',
      GRAPHFLOW_EMBED_WORKER: '0',
      GRAPHFLOW_CORS_ORIGINS: 'http://localhost:3000,https://app.example.com',
      GRAPHFLOW_HOST: '0.0.0.0',
      PORT: '8080',
    });
    expect(env).toEqual({
      temporalAddress: 'my-ns.a1b2c.tmprl.cloud:7233',
      temporalNamespace: 'my-ns.a1b2c',
      temporalApiKey: 'not-a-real-key',
      temporalTaskQueue: 'graphflow-queue',
      dbPath: '/tmp/scratch.sqlite3',
      storageRoot: '/tmp/storage',
      embedWorker: false,
      corsOrigins: ['http://localhost:3000', 'https://app.example.com'],
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('applies defaults when nothing is set', () => {
    const env = parseEnv({});
    expect(env.temporalAddress).toBe('localhost:7233');
    expect(env.temporalNamespace).toBe('default');
    expect(env.temporalTaskQueue).toBe('thet-dev-graphflow');
    expect(env.temporalApiKey).toBeUndefined();
    expect(env.dbPath).toBe('graphflow.sqlite3');
    expect(env.storageRoot).toBe('mock_s3_gcs');
    expect(env.embedWorker).toBe(true);
    expect(env.corsOrigins).toEqual(['http://localhost:3000']);
    expect(env.host).toBe('127.0.0.1');
    expect(env.port).toBe(8000);
  });

  it('rejects an explicitly empty Temporal var (empty string is a config error, not a default)', () => {
    expect(() => parseEnv({ ...REQUIRED, TEMPORAL_NAMESPACE: '' })).toThrow(ValidationError);
    expect(() => parseEnv({ ...REQUIRED, TEMPORAL_TASK_QUEUE: '' })).toThrow(ValidationError);
    expect(() => parseEnv({ ...REQUIRED, TEMPORAL_ADDRESS: '' })).toThrow(ValidationError);
  });

  it('treats GRAPHFLOW_EMBED_WORKER as false only for the exact string "0"', () => {
    expect(parseEnv({ ...REQUIRED, GRAPHFLOW_EMBED_WORKER: '0' }).embedWorker).toBe(false);
    expect(parseEnv({ ...REQUIRED, GRAPHFLOW_EMBED_WORKER: '1' }).embedWorker).toBe(true);
    expect(parseEnv({ ...REQUIRED, GRAPHFLOW_EMBED_WORKER: 'false' }).embedWorker).toBe(true);
    expect(parseEnv({ ...REQUIRED, GRAPHFLOW_EMBED_WORKER: '' }).embedWorker).toBe(true);
  });

  it('splits, trims, and drops empty CORS origins', () => {
    const env = parseEnv({
      ...REQUIRED,
      GRAPHFLOW_CORS_ORIGINS: ' http://localhost:3000 , https://app.example.com ,, ',
    });
    expect(env.corsOrigins).toEqual(['http://localhost:3000', 'https://app.example.com']);
  });

  it('coerces PORT to an integer and rejects non-integers', () => {
    expect(parseEnv({ ...REQUIRED, PORT: '9001' }).port).toBe(9001);
    expect(() => parseEnv({ ...REQUIRED, PORT: 'not-a-port' })).toThrow(ValidationError);
    expect(() => parseEnv({ ...REQUIRED, PORT: '8000.5' })).toThrow(ValidationError);
  });

  it('treats an empty TEMPORAL_API_KEY as unset', () => {
    expect(parseEnv({ ...REQUIRED, TEMPORAL_API_KEY: '' }).temporalApiKey).toBeUndefined();
  });

  it('names the offending variable in the ValidationError message', () => {
    expect(() => parseEnv({ ...REQUIRED, TEMPORAL_NAMESPACE: '', TEMPORAL_ADDRESS: '' })).toThrow(
      /TEMPORAL_ADDRESS.*TEMPORAL_NAMESPACE|TEMPORAL_NAMESPACE.*TEMPORAL_ADDRESS/
    );
  });
});
