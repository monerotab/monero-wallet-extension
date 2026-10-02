import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: 'standalone.spec.ts', fullyParallel: false, workers: 1, timeout: 90_000,
  expect: { timeout: 20_000 },
  // Every test loads the actual unpacked extension. No development or wallet RPC server.
  use: { trace: 'off', screenshot: 'off' },
  reporter: [['list']],
});
