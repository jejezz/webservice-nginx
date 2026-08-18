import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Nginx 의 /rtc-relay/ 라우트 + 서비스의 /dashboard 경로.
// 라우터 basename 과 API 경로가 모두 이 값에서 파생된다.
const BASE = '/rtc-relay/dashboard/';

export default defineConfig({
  base: BASE,
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    // rtc-relay-server 가 이 디렉토리를 그대로 서빙한다.
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
  server: {
    port: 5185,
    proxy: {
      // 개발 서버에서 API 는 서비스 백엔드로 넘긴다. 자체 서명 HTTPS 라 검증을 끈다.
      '/rtc-relay/dashboard/api': {
        target: 'https://127.0.0.1:28099',
        secure: false,
        changeOrigin: true,
      },
    },
  },
});
