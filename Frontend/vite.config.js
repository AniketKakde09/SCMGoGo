import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Foreman Knowledge API (FastAPI) runs on http://localhost:8000
// by default (see README_API.md). CORS is already open on the backend,
// so the frontend can talk to it directly - this proxy is kept only as
// a convenience if you prefer relative "/api" calls in local dev.
export default defineConfig({
  plugins: [react()],

  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
