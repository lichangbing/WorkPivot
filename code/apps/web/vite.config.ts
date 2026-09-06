/** 前端构建配置：dev 代理 /api → 服务层 39800（桌面形态同源无需代理）。 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
  server: {
    proxy: {
      // dev 模式：前端 5173 → 服务层 39800（桌面形态同源无需代理）
      '/api': 'http://127.0.0.1:39800',
    },
  },
});
