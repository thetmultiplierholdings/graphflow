import { coverageConfigDefaults, defineConfig, mergeConfig } from 'vitest/config';

import configShared from './vitest.shared.mjs';

export default mergeConfig(
  configShared,
  defineConfig({
    test: {
      root: import.meta.dirname,
      projects: ['apps/*/vitest.config.mjs', 'libs/*/*/vitest.config.mjs'],
      coverage: {
        exclude: ['*.mjs', '**/coverage/**', ...coverageConfigDefaults.exclude],
      },
    },
  })
);
