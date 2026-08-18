import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nginx의 기본 웹페이지를 대신하므로 루트에 붙는다.
// server/src/config.js의 basePath와 반드시 같아야 한다. (라우터 basename도 이 값을 따른다)
const BASE = '/';

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
      '/api': 'http://127.0.0.1:28084',
    },
  },
});
