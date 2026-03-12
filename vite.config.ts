import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    proxy: {
      '/api/rss-proxy': {
        target: 'https://api.rss2json.com/v1/api.json',
        changeOrigin: true,
        rewrite: (path) => {
          const url = new URL(path, 'http://localhost');
          const feedUrl = url.searchParams.get('url') || '';
          return `?rss_url=${encodeURIComponent(feedUrl)}&api_key=open`;
        },
      },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify('3.0.0'),
  },
  optimizeDeps: {
    entries: ['index.html'],
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
  },
});
