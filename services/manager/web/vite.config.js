import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nginx가 /manager/ 경로로 프록시하므로 base와 라우터 basename을 맞춘다.
const BASE = '/manager/';

export default defineConfig({
  base: BASE,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // 빌드 결과를 백엔드가 그대로 서빙한다.
    outDir: path.resolve(__dirname, '../server/public'),
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    proxy: {
      // 개발 서버에서 API는 manager 백엔드로 넘긴다.
      '/manager/api': 'http://127.0.0.1:28084',
    },
  },
});
