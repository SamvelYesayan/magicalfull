import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// /admin and /pioneer-card are separate HTML entry points (multi-page build). The tiny plugin
// below maps those clean URLs to their .html files in dev; server/static.js does the same in production.
const cleanUrls = () => ({
  name: 'magical-clean-urls',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const m = /^\/(admin)\/?(\?.*)?$/.exec(req.url || '');
      if (m) req.url = `/${m[1]}.html${m[2] || ''}`;
      const p = /^\/pioneer-card(?:\/(?:login|account))?\/?(\?.*)?$/.exec(req.url || '');
      if (p) req.url = `/pioneer.html${p[1] || ''}`;
      next();
    });
  },
});

export default defineConfig({
  plugins: [cleanUrls()],
  server: { host: true, proxy: { '/api': 'http://127.0.0.1:3000' } }, // run `npm run server` alongside `npm run dev`
  build: {
    rollupOptions: {
      input: { main: resolve(import.meta.dirname, 'index.html'), admin: resolve(import.meta.dirname, 'admin.html'), pioneer: resolve(import.meta.dirname, 'pioneer.html') },
    },
  },
});
