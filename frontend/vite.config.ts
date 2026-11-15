import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['frontend'],
    watch: {
      usePolling: process.env.WATCH_USE_POLLING !== 'false',
      interval: Number(process.env.WATCH_INTERVAL_MS ?? 500),
    },
    proxy: {
      // Applies to REST and future SSE routes, without rewriting /api.
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://backend:3000',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
});
