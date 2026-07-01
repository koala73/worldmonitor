import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

const STATIC_SCRIPT_NONCE = 'wm-static-bootstrap';

function isWelcomeHtml(hostId: string) {
  return hostId === 'welcome.html' || hostId.endsWith('/welcome.html');
}

function isWelcomeHydrationPreload(dep: string) {
  const basename = dep.split('/').pop() ?? dep;
  return basename.startsWith('index-') && basename.endsWith('.js');
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/pro/',
  html: {
    cspNonce: STATIC_SCRIPT_NONCE,
  },
  build: {
    modulePreload: {
      resolveDependencies: (filename, deps, context) => {
        if (context.hostType !== 'html') return deps;

        const hostId = 'hostId' in context && typeof context.hostId === 'string'
          ? context.hostId
          : filename;
        if (!isWelcomeHtml(hostId)) return deps;

        return deps.filter(dep => !isWelcomeHydrationPreload(dep));
      },
    },
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
