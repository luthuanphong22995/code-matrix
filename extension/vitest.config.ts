import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./test/unit/mocks/vscode.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
  },
});
