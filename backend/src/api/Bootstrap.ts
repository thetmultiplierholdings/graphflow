import type { Client } from '@temporalio/client';
import { pino } from 'pino';
import { buildRegistry } from '../domain/registry/Registry.js';
import { connect, initDb, publishCatalog } from '../infrastructure/db/Db.js';
import { loadEnv } from '../infrastructure/env/Env.js';
import { errorMessage } from '../shared/errors/Errors.js';
import { adoptOpenWorkflows, connectClient, createWorker, type WorkerHandle } from '../temporal/Runtime.js';
import { ALL_WORKFLOWS } from '../workflows/index.js';
import { buildApp } from './App.js';
import type { ApiDeps } from './Deps.js';
import { createTemporalGateway } from './Deps.js';

// Startup order: env → db init → registry → publish catalog → Temporal client → optional embedded
// worker → listen. Shutdown: close app, shutdown worker, close client connection.
export async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

  const instance = initDb(env.dbPath);
  const registry = buildRegistry(ALL_WORKFLOWS);
  const conn = connect(env.dbPath);
  try {
    for (const line of publishCatalog(conn, registry)) {
      logger.info(`[catalog] ${line}`);
    }
  } finally {
    conn.close();
  }

  const client: Client = await connectClient(env);
  const deps: ApiDeps = {
    connect: () => connect(env.dbPath),
    env,
    temporal: createTemporalGateway({ client, env, dbPath: env.dbPath, instance }),
    registry,
    instance,
    storageRoot: env.storageRoot,
    dbPath: env.dbPath,
  };
  const app = await buildApp(deps, { loggerInstance: logger });

  let worker: WorkerHandle | undefined;
  let workerRun: Promise<void> | undefined;
  if (env.embedWorker) {
    worker = await createWorker(env, client, env.dbPath, env.storageRoot, instance, registry);
    workerRun = worker.worker.run();
    const watchWorker = async (): Promise<void> => {
      try {
        await workerRun;
      } catch (e) {
        logger.error(`[worker] embedded worker stopped: ${errorMessage(e)}`);
      }
    };
    void watchWorker();
    logger.info(`[worker] embedded worker running (task queue '${env.temporalTaskQueue}')`);
    const adopted = await adoptOpenWorkflows(client, env, instance);
    if (adopted > 0) {
      logger.info(`[worker] adopted ${adopted} open workflow(s) from previous worker`);
    }
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`received ${signal} — shutting down`);
    await app.close();
    if (worker !== undefined) {
      worker.worker.shutdown();
      try {
        await workerRun;
      } catch {
        // already logged by watchWorker
      }
      await worker.close();
    }
    await client.connection.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      const run = async (): Promise<void> => {
        try {
          await shutdown(signal);
          process.exit(0);
        } catch (e) {
          logger.error(`shutdown failed: ${errorMessage(e)}`);
          process.exit(1);
        }
      };
      void run();
    });
  }

  await app.listen({ port: env.port, host: env.host });
}
