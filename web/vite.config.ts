import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development, /api and /mcp go to the local server (uvicorn on :8080).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8080', '/mcp': 'http://localhost:8080' },
  },
});
