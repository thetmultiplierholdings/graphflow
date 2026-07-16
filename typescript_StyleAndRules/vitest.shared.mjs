import { createHash } from 'node:crypto';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build the reporters array based on environment configuration.
 * Includes the Sentry test metrics reporter when TEST_METRICS_ENABLED=1.
 *
 * The reporters are loaded from TypeScript source so merge-group CI can start
 * Vitest before workspace packages have been built.
 */
const testMetricsReporterSourceRoot = join(__dirname, 'libs/scripts/vitest-metrics-reporters/src');
const reporters = ['default'];

if (process.env.TEST_METRICS_ENABLED === '1') {
  reporters.push([
    join(testMetricsReporterSourceRoot, 'SentryTestMetricsReporter.ts'),
    {
      dsn: process.env.SENTRY_DSN,
      environment: process.env.DEPLOY_ENV ?? 'ci',
    },
  ]);

  // Write per-module timing data to JSON for CI metrics publishing.
  // Each Nx project runs Vitest in its own process, so use a unique file per
  // project to avoid overwriting. NX_TASK_TARGET_PROJECT is set automatically
  // by Nx during task execution.
  const rawProject = process.env.NX_TASK_TARGET_PROJECT ?? 'default';
  const projectSuffix = createHash('sha256').update(rawProject).digest('hex').slice(0, 12);
  reporters.push([
    join(testMetricsReporterSourceRoot, 'CIMetricsReporter.ts'),
    {
      outputPath: join(__dirname, `logs/vitest-module-timing-${projectSuffix}.json`),
    },
  ]);
}

// Calculate reasonable worker limits to prevent resource exhaustion
// Default: half of CPUs, minimum 1, maximum 4 for dev machines
// Override with VITEST_MAX_FORKS environment variable (clamped to [1, cpuCount])
const cpuCount = os.cpus().length;
const defaultMaxWorkers = Math.min(Math.max(1, Math.floor(cpuCount / 2)), 4);

function parseMaxWorkers(envValue) {
  if (!envValue || envValue.trim() === '') {
    return defaultMaxWorkers;
  }
  const parsed = Number.parseInt(envValue, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return defaultMaxWorkers;
  }
  // Clamp to [1, cpuCount] to prevent absurd values
  return Math.max(1, Math.min(cpuCount, parsed));
}

// Vitest 4 renamed the worker-override env var to VITEST_MAX_WORKERS. Prefer it,
// and fall back to the legacy VITEST_MAX_FORKS for backward compatibility.
const maxWorkers = parseMaxWorkers(process.env.VITEST_MAX_WORKERS ?? process.env.VITEST_MAX_FORKS);

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      '.nx',
      '**/dist/**',
      '**/out-tsc/**',
      '**/node_modules/**',
      '**/.yarn/**',
      '**/coverage/**',
      '**/.rollup.cache/**',
    ],
    globalSetup: join(__dirname, 'vitest.globalSetup.mjs'),
    setupFiles: [
      join(__dirname, 'libs/shared/testing/src/vitest.setup.ts'),
      join(__dirname, 'libs/shared/decimal-testing/src/vitest.setup.ts'),
    ],
    reporters,
    includeTaskLocation: true,

    // Pool configuration to limit concurrent workers and prevent resource exhaustion
    // See: https://linear.app/multiplierholdings/issue/PLA-662
    // Vitest 4: poolOptions removed; maxForks/minForks → top-level maxWorkers/isolate.
    pool: 'forks',
    maxWorkers,
    isolate: true,

    // Allow cleanup time before force-killing on shutdown
    teardownTimeout: 5000,
  },
});
