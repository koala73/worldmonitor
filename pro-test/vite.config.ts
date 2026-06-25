import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/pro/',
  html: {
    cspNonce: STATIC_SCRIPT_NONCE,
  },
  build: {
    outDir: path.resolve(__dirname, '../public/pro'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, 'index.html'),
        welcome: path.resolve(__dirname, 'welcome.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
