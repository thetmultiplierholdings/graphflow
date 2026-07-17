import os from 'node:os';
import { configDefaults, defineConfig } from 'vitest/config';

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
  return Math.max(1, Math.min(cpuCount, parsed));
}

const maxWorkers = parseMaxWorkers(process.env.VITEST_MAX_WORKERS ?? process.env.VITEST_MAX_FORKS);

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: [...configDefaults.exclude, '**/dist/**', '**/out-tsc/**', '**/node_modules/**', '**/coverage/**'],
    includeTaskLocation: true,
    pool: 'forks',
    maxWorkers,
    isolate: true,
    teardownTimeout: 5000,
    coverage: { provider: 'v8', reportsDirectory: './coverage' },
  },
});
