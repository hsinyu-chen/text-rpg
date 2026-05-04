import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

const r = (p: string) => resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@app\/core\/(.*)$/, replacement: r('src/app/core/$1') },
      { find: /^@app\/features\/(.*)$/, replacement: r('src/app/features/$1') },
      { find: /^@app\/shared\/(.*)$/, replacement: r('src/app/shared/$1') },
      {
        find: '@hcs/llm-core',
        replacement: r('lib/hcs-llm-monorepo/packages/core/src/index.ts'),
      },
      {
        find: '@hcs/llm-provider-gemini',
        replacement: r('lib/hcs-llm-monorepo/packages/provider-gemini/src/index.ts'),
      },
      {
        find: '@hcs/llm-provider-llama-cpp',
        replacement: r('lib/hcs-llm-monorepo/packages/provider-llama-cpp/src/index.ts'),
      },
      {
        find: '@hcs/llm-provider-openai',
        replacement: r('lib/hcs-llm-monorepo/packages/provider-openai/src/index.ts'),
      },
      {
        find: '@hcs/llm-angular-common',
        replacement: r('lib/hcs-llm-monorepo/packages/angular-common/src/index.ts'),
      },
      {
        find: '@hcs/llm-angular-settings',
        replacement: r('lib/hcs-llm-monorepo/packages/angular-settings/src/index.ts'),
      },
      {
        find: '@hcs/llm-angular-ui-gemini',
        replacement: r('lib/hcs-llm-monorepo/packages/angular-ui-gemini/src/index.ts'),
      },
      {
        find: '@hcs/llm-angular-ui-llama-cpp',
        replacement: r('lib/hcs-llm-monorepo/packages/angular-ui-llama-cpp/src/index.ts'),
      },
      {
        find: '@hcs/llm-angular-ui-openai',
        replacement: r('lib/hcs-llm-monorepo/packages/angular-ui-openai/src/index.ts'),
      },
    ],
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.spec.ts', 'src/**/*.test.ts'],
  },
});
