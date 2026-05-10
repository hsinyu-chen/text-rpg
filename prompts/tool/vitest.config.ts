import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'prompts-tool',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    root: __dirname,
  },
});
