import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    globals: false,
    environment: 'node',
    testTimeout: 15_000,
  },
});
