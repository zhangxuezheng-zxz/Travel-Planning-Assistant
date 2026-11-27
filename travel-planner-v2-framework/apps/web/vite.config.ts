import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import { resolveDevApiTarget } from './dev-api-target.ts';

const appDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig(({ mode }) => {
  const envDir = resolve(appDir, '../..');
  const env = loadEnv(mode, envDir, '');
  const apiTarget = resolveDevApiTarget(mode, env);
  return {
    root: appDir,
    envDir,
    plugins: [react()],
    // 工作区CJS引擎更新后，旧预编译缓存曾导致页面白屏；开发启动时重新生成。
    optimizeDeps: {
      include: ['@travel/shared/recommendation-engine'],
      force: mode === 'development',
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: apiTarget, changeOrigin: true } },
    },
  };
});
