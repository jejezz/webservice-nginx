import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nginx의 /janus/ 라우트 + 서비스의 /dashboard 경로.
// 라우터 basename과 API 경로가 모두 이 값에서 파생된다.
const BASE = '/janus/dashboard/';

export default defineConfig({
  base: BASE,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // janus-dashboard 서버가 이 디렉토리를 그대로 서빙한다.
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5187,
    proxy: {
      '/janus/dashboard/api': 'http://127.0.0.1:28087',
      // 개발 서버에서도 janus.js 가 진짜 Janus 에 붙게 한다.
      '/janus-api': 'http://127.0.0.1:8088',
    },
  },
});
