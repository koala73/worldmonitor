// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Lastmod computation lives in post-dates.mjs so it stays importable without
// this workspace's node_modules. Import it from there, not through this file:
// anything reaching it via astro.config.mjs pulls astro/config in with it,
// which is what broke the unit job after #7646.
import { POST_DATES } from './post-dates.mjs';

export default defineConfig({
  site: 'https://www.worldmonitor.app',
  base: '/blog',
  output: 'static',
  integrations: [
    sitemap({
      serialize(item) {
        const lastmod = POST_DATES.get(item.url);
        if (lastmod) return { ...item, lastmod };
        return item;
      },
    }),
  ],
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});
