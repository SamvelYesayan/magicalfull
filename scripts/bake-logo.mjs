// One-off dev script: bakes public/assets/magical-m.png into a raw alpha mask used by the PDF
// generator (the logo is pure white, so only its alpha channel is needed).
// Requires `sharp` (dev only): npm i -D sharp && node scripts/bake-logo.mjs
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
const { data, info } = await sharp('public/assets/magical-m.png').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const alpha = Buffer.alloc(info.width * info.height);
let nonWhite = 0;
for (let i = 0; i < alpha.length; i++) { alpha[i] = data[i * 4 + 3]; if (alpha[i] > 8 && (data[i*4] < 250 || data[i*4+1] < 250 || data[i*4+2] < 250)) nonWhite++; }
if (nonWhite > alpha.length * 0.001) throw new Error('Logo is not pure white; baking as a stencil would change its look');
writeFileSync('server/assets/logo-alpha.bin', deflateSync(alpha, { level: 9 }));
writeFileSync('server/assets/logo.json', JSON.stringify({ width: info.width, height: info.height }));
console.log('baked', info.width, 'x', info.height);
