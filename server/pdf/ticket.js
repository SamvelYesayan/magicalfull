// Shared PDF resources (embedded fonts + the white "M" logo), used by the Pioneer Card PDFs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { TTFont, FontStack } from './font.js';

const assets = (f) => fileURLToPath(new URL('../assets/' + f, import.meta.url));
let cache = null;
export function getResources() {
  if (cache) return cache;
  const F = (ps, f) => new TTFont(ps, assets('fonts/' + f));
  const inter = (w) => ['latin', 'latin-ext', 'cyrillic', 'cyrillic-ext'].map((s) => F(`Inter-${w === 400 ? 'Regular' : 'Bold'}-${s}`, `inter-${s}-${w}.woff`));
  const arm = (w) => F(`NotoSansArmenian-${w === 400 ? 'Regular' : 'Bold'}`, `noto-armenian-${w}.woff`);
  const i4 = inter(400), i7 = inter(700);
  const body = (a, i) => new FontStack([i[0], a, ...i.slice(1)]);
  const B4 = body(arm(400), i4), B7 = body(arm(700), i7);
  const DISP = new FontStack([F('Outfit-Bold-latin', 'outfit-latin-700.woff'), F('Outfit-Bold-latin-ext', 'outfit-latin-ext-700.woff'), ...B7.fonts]);
  const meta = JSON.parse(readFileSync(assets('logo.json'), 'utf8'));
  const alpha = inflateSync(readFileSync(assets('logo-alpha.bin')));
  // solid white; raw pixels, because PdfDoc.stream deflates every stream itself (deflating here too made
  // the image stream double-compressed, and PDF viewers silently dropped the logo)
  const rgb = Buffer.alloc(meta.width * meta.height * 3, 255);
  cache = { B4, B7, DISP, logo: { ...meta, alpha, rgb } };
  return cache;
}
