/** 前端构建配置：dev 代理 /api → 服务层 39800（桌面形态同源无需代理）。 */
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // dev 模式：前端 5173 → 服务层 39800（桌面形态同源无需代理）
      '/api': 'http://127.0.0.1:39800',
    },
  },
});
