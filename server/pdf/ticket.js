// Invitation ticket PDF: layout, fonts and builders (single ticket and streamed bundle).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { EVENT } from '../../shared/event.js';
import { code39 } from '../../shared/code39.js';
import { TTFont, FontStack } from './font.js';
import { PdfDoc, Canvas, bufferSink } from './writer.js';

const W = 700, H = 320;
const BG = [0.035, 0.035, 0.043], PANEL = [0.075, 0.075, 0.086], LINE = [0.2, 0.2, 0.23];
const PRI = [0.545, 0.361, 0.965], PRI2 = [0.655, 0.545, 0.98], SKY = [0.22, 0.74, 0.973];
const TXT = [0.98, 0.98, 0.98], MUT = [0.63, 0.63, 0.67];

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

const fnc = (c0, c1, n = 1) => `<< /FunctionType 2 /Domain [0 1] /C0 [${c0.join(' ')}] /C1 [${c1.join(' ')}] /N ${n} >>`;
const mix = (a, b, t) => a.map((v, i) => +(v + (b[i] - v) * t).toFixed(4));

async function prepare(doc) {
  const { logo } = getResources();
  const y = (v) => H - v;
  return {
    strip: await doc.shading('strip', `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [18 0 682 0] /Function << /FunctionType 3 /Domain [0 1] /Functions [${fnc(PRI, PRI2)} ${fnc(PRI2, SKY)}] /Bounds [0.55] /Encode [0 1 0 1] >> /Extend [true true] >>`),
    glow1: await doc.shading('glow1', `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [120 ${y(30)} 0 120 ${y(30)} 270] /Function ${fnc(mix(PANEL, PRI, 0.3), PANEL, 1.6)} /Extend [false false] >>`),
    glow2: await doc.shading('glow2', `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [610 ${y(300)} 0 610 ${y(300)} 230] /Function ${fnc(mix(PANEL, SKY, 0.22), PANEL, 1.6)} /Extend [false false] >>`),
    logo: await doc.image('logo', { w: logo.width, h: logo.height, rgb: logo.rgb, alpha: logo.alpha }),
  };
}

function wrap(stack, text, size, maxW) {
  const lines = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const t = cur ? cur + ' ' + word : word;
    if (stack.width(t, size) <= maxW) { cur = t; continue; }
    if (cur) lines.push(cur);
    cur = word;
    while (stack.width(cur, size) > maxW && cur.length > 1) { // single very long word: split by characters
      let k = cur.length;
      while (k > 1 && stack.width(cur.slice(0, k), size) > maxW) k--;
      lines.push(cur.slice(0, k)); cur = cur.slice(k);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
function fit(stack, text, maxW, size, min) {
  while (size > min && stack.width(text, size) > maxW) size -= 0.5;
  return size;
}

export async function drawTicket(doc, res, d) {
  const { B4, B7, DISP, logo } = getResources();
  const c = new Canvas(doc);
  const fullName = `${d.firstName} ${d.lastName}`;
  c.fillRect(0, 0, W, H, BG);
  c.fillRR(18, 18, 664, 284, 18, PANEL);
  // glows + top accent strip, clipped to the card
  c.clipRR(18, 18, 664, 284, 18).shade(res.glow1).shade(res.glow2).restore();
  c.clipRR(18, 18, 664, 284, 18).clipRect(18, 18, 664, 4).shade(res.strip).restore().restore();
  c.strokeRR(18, 18, 664, 284, 18, 1, LINE);

  // --- main block -------------------------------------------------------
  const lh = 26, lw = (logo.width / logo.height) * lh;
  await c.drawImage(res.logo, 44, 42, lw, lh);
  await c.text(DISP, 'MAGICAL', 44 + lw + 10, 42 + 19, 19, TXT, { spacing: 0.8 });
  const pill = 'ՀՐԱՎԻՐԱՏՈՄՍ', pw = B7.width(pill, 7.5, 1.8) + 24;
  c.fillRR(496 - pw, 44, pw, 22, 11, mix(PANEL, PRI, 0.18)).strokeRR(496 - pw, 44, pw, 22, 11, 0.8, mix(PANEL, PRI, 0.6));
  await c.text(B7, pill, 496 - pw / 2 + 0.9, 58.2, 7.5, PRI2, { align: 'center', spacing: 1.8 });

  await c.text(B4, 'ՀՐԱՎԻՐՎՈՒՄ Է', 44, 112, 8, MUT, { spacing: 1.8 });
  let size = fit(B7, fullName, 452, 32, 21);
  if (B7.width(fullName, size) <= 452) await c.text(B7, fullName, 44, 148, size, TXT);
  else {
    size = 21;
    let lines = wrap(B7, fullName, size, 452);
    while (lines.length > 2 && size > 13) lines = wrap(B7, fullName, (size -= 1), 452);
    for (const [i, l] of lines.slice(0, 2).entries()) await c.text(B7, l, 44, 138 + i * (size + 4), size, TXT);
  }
  await c.text(B7, `«${EVENT.name}»`, 44, 190, 15, PRI2);

  c.line(44, 208, 496, 208, 0.8, LINE);
  const lab = (t, x) => c.text(B4, t, x, 226, 7.5, MUT, { spacing: 1.6 });
  await lab('ԱՄՍԱԹԻՎ', 44); await lab('ԺԱՄ', 168); await lab('ՎԱՅՐ', 238);
  await c.text(B7, EVENT.dateText, 44, 244, 12.5, TXT);
  await c.text(B7, EVENT.time, 168, 244, 12.5, TXT);
  for (const [i, l] of wrap(B7, EVENT.location, 11, 258).slice(0, 2).entries()) await c.text(B7, l, 238, 244 + i * 14, 11, TXT);
  c.star(48, 281, 5, SKY);
  await c.text(B4, EVENT.giftsNote, 60, 284, 9.5, MUT);

  // --- perforation + notches ------------------------------------------------
  c.line(520, 34, 520, 286, 1, mix(LINE, MUT, 0.25), [4, 4]);
  c.fillCircle(520, 18, 12, BG).fillCircle(520, 302, 12, BG);

  // --- stub -----------------------------------------------------------------
  const cx = 601;
  const lbl = 'ՀՐԱՎԻՐԱՏՈՄՍԻ ՀԱՄԱՐ';
  await c.text(B4, lbl, cx, 58, fit(B4, lbl, 118, 7, 5.5), MUT, { align: 'center', spacing: 0.9 });
  await c.text(DISP, d.invitationNo, cx, 82, fit(DISP, d.invitationNo, 118, 16, 11), TXT, { align: 'center', spacing: 0.6 });
  // Code 39 barcode of the 6-character code (light plate, dark bars)
  const code = d.invitationNo.replace(/^MGC-/, '');
  const bc = code39(code, 2), scale = 92 / bc.width;
  c.fillRR(541, 98, 120, 76, 8, TXT);
  c.color([0.04, 0.04, 0.05]);
  for (const b of bc.bars) c.rectPath(555 + b.x * scale, 108, b.w * scale, 46), c.add('f');
  await c.text(DISP, code, cx, 168, 8.5, [0.2, 0.2, 0.24], { align: 'center', spacing: 2.5 });
  await c.text(DISP, 'LEARN.', cx, 212, 12, PRI2, { align: 'center', spacing: 2 });
  await c.text(DISP, 'BUILD.', cx, 232, 12, TXT, { align: 'center', spacing: 2 });
  await c.text(DISP, 'CONQUER.', cx, 252, 12, SKY, { align: 'center', spacing: 2 });
  await doc.addPage(c.toString());
}

const titleFor = (d) => `Magical — ${EVENT.name} — ${d.invitationNo}`;

export async function renderInvitationPdf(d) {
  const sink = bufferSink();
  const doc = new PdfDoc(sink, { title: titleFor(d), width: W, height: H });
  await doc.start();
  await drawTicket(doc, await prepare(doc), d);
  await doc.end();
  return sink.result();
}

/** Streams a PDF with one ticket per row. `rows` may be any (async) iterable; memory use is constant. */
export async function streamInvitationsPdf(sink, rows) {
  const doc = new PdfDoc(sink, { title: `Magical — ${EVENT.name} — հրավիրատոմսեր`, width: W, height: H });
  await doc.start();
  const res = await prepare(doc);
  let n = 0;
  for await (const d of rows) { await drawTicket(doc, res, d); n++; }
  await doc.end();
  return n;
}
