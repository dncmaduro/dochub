import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/** Shared PostgreSQL fixtures use SERIALIZABLE transactions, so files run in order. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.integration.spec.ts'],
    fileParallelism: false,
  },
});
