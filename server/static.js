import { createReadStream, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const PAGES = { '/': 'index.html', '/invitation': 'invitation.html', '/admin': 'admin.html', '/pioneer-card': 'pioneer.html', '/pioneer-card/login': 'pioneer.html', '/pioneer-card/account': 'pioneer.html' };

/** Serves the built frontend (dist/). Clean URLs: /invitation and /admin map to their HTML pages. */
export function serveStatic(root, req, res, pathname) {
  let rel = pathname.replace(/\/+$/, '') || '/';
  rel = PAGES[rel] ?? rel.slice(1);
  let file;
  try { file = resolve(root, decodeURIComponent(rel)); } catch { return false; }
  if (file !== root && !file.startsWith(root + sep)) return false; // path traversal guard
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const ext = extname(file).toLowerCase();
  const isPage = ext === '.html';
  const hashed = /-[A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(file);
  const noindex = /\/(admin|invitation)\.html$/.test(file) ? { 'X-Robots-Tag': 'noindex, nofollow' } : {};
  res.writeHead(200, {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': isPage ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    ...(file.endsWith('admin.html') ? { 'Cache-Control': 'no-store' } : {}),
    ...noindex,
  });
  if (req.method === 'HEAD') return res.end(), true;
  createReadStream(file).pipe(res);
  return true;
}
