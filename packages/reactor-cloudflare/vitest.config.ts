import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Bundle the worker entry (all deps inlined) once per run; miniflare
    // loads that single self-contained module.
    globalSetup: ['./tests/global-setup.ts'],
    // miniflare spawns workerd; keep tests sequential and generous.
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
