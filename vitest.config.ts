import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: [
      { find: /^@/, replacement: path.resolve(__dirname, './src') },
      // node:sqlite（Node 22.5+ 内置）不在 vite/vitest 的内置模块清单里，
      // 测试环境下指向 CJS shim（Node 原生 require），生产代码不受影响
      { find: /^node:sqlite$/, replacement: path.resolve(__dirname, './vitest-node-sqlite.cjs') },
    ],
  },
});
