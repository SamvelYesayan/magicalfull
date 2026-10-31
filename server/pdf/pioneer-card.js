// Printable Pioneer Card: one page at the exact ID-1 card size (85.60 x 53.98 mm), full bleed.
// Shows the official logo, "PIONEER CARD", the 8-digit number and the holder's name (or a blank
// line for handwriting). Never the phone number; the CVV only when the A4 print sheet passes it (this single-card
// page never does). Mirrors src/modules/pioneer-card-view.js. drawCardFront is shared with pioneer-sheet.js.
import { PdfDoc, Canvas, bufferSink } from './writer.js';
import { getResources } from './ticket.js';

const MM = 72 / 25.4;
export const CARD_W = +(85.6 * MM).toFixed(2), CARD_H = +(53.98 * MM).toFixed(2); // 242.65 x 153.01 pt

export const BG = [0.059, 0.039, 0.122], PRI = [0.545, 0.361, 0.965], PRI2 = [0.769, 0.71, 0.992], SKY = [0.22, 0.74, 0.973];
export const TXT = [0.98, 0.98, 0.98], MUT = [0.72, 0.7, 0.8], LINE = [0.6, 0.56, 0.72];
// the six small labels, a little brighter than MUT / PRI2 so they stay readable when printed on the dark card
const LABEL = [0.831, 0.816, 0.894], LABEL_ACCENT = [0.847, 0.8, 1]; // #D4D0E4, #D8CCFF
export const fnc = (c0, c1, n = 1) => `<< /FunctionType 2 /Domain [0 1] /C0 [${c0.join(' ')}] /C1 [${c1.join(' ')}] /N ${n} >>`;
export const mix = (a, b, t) => a.map((v, i) => +(v + (b[i] - v) * t).toFixed(4));

export const formatNo = (n) => `${n.slice(0, 4)} ${n.slice(4)}`;

// Draws the card front on a canvas whose page is CARD_W x CARD_H (c.H = CARD_H). `bleed` (pt) extends the
// background past the trim edge for sheet printing; 0 keeps the single-card page exactly as before.
export async function drawCardFront(doc, c, { number, firstName, lastName, cvv }, bleed = 0) {
  const { B7, B4, DISP, logo } = getResources();
  const W = CARD_W, H = CARD_H, b = bleed;
  const y = (v) => +(H - v).toFixed(2);
  const glow1 = await doc.shading('pc-glow1', `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [30 ${y(0)} 0 30 ${y(0)} 190] /Function ${fnc(mix(BG, PRI, 0.62), BG, 1.4)} /Extend [false false] >>`);
  const glow2 = await doc.shading('pc-glow2', `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${W} ${y(H)} 0 ${W} ${y(H)} 150] /Function ${fnc(mix(BG, SKY, 0.28), BG, 1.6)} /Extend [false false] >>`);
  const strip = await doc.shading('pc-strip', `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 ${W} 0] /Function << /FunctionType 3 /Domain [0 1] /Functions [${fnc(PRI, PRI2)} ${fnc(PRI2, SKY)}] /Bounds [0.55] /Encode [0 1 0 1] >> /Extend [true true] >>`);
  const img = await doc.image('logo', { w: logo.width, h: logo.height, rgb: logo.rgb, alpha: logo.alpha });
  const lighten = await doc.gstate('lighten', '<< /Type /ExtGState /BM /Lighten >>'); // like the CSS gradients: a glow never darkens the other

  c.clipRect(-b, -b, W + 2 * b, H + 2 * b); // artwork never leaves its own bleed box
  c.fillRect(-b, -b, W + 2 * b, H + 2 * b, BG);
  c.clipRect(-b, -b, W + 2 * b, H + 2 * b).shade(glow1).add(`/${lighten} gs`).shade(glow2).restore();
  // fine concentric rings (decoration, right side)
  for (const [r, t] of [[58, 0.22], [78, 0.16], [98, 0.11]]) {
    c.save().color(mix(BG, PRI2, t), true).add('0.45 w'); c.circlePath(W + 6, H * 0.42, r); c.add('S').restore();
  }
  c.clipRect(-b, H - 3, W + 2 * b, 3 + b).shade(strip).restore();

  const pad = 15.5;
  const lh = 13, lw = (logo.width / logo.height) * lh;
  await c.drawImage(img, pad, 14, lw, lh);
  await c.text(DISP, 'MAGICAL', pad + lw + 6, 14 + 10, 10, TXT, { spacing: 0.6 });
  await c.text(DISP, 'PIONEER CARD', W - pad, 23.5, 8.2, LABEL_ACCENT, { align: 'right', spacing: 1.9 });

  await c.text(B4, 'CARD NUMBER', pad, 66, 5.2, LABEL, { spacing: 1.3 });
  await c.text(DISP, formatNo(number), pad, 88, 19, TXT, { spacing: 2.6 });
  if (cvv) { // small, right-aligned on the card-number row (the writer counts spacing after the last glyph: shift by it)
    await c.text(B4, 'CVV', W - pad + 1.3, 66, 5.2, LABEL, { align: 'right', spacing: 1.3 });
    await c.text(DISP, cvv, W - pad + 1.2, 86, 11, TXT, { align: 'right', spacing: 1.2 });
  }

  await c.text(B4, 'CARDHOLDER', pad, 112, 5.2, LABEL, { spacing: 1.3 });
  const name = [firstName, lastName].filter(Boolean).join(' ');
  if (name) {
    let size = 10.5;
    while (size > 6.5 && B7.width(name, size) > 150) size -= 0.5;
    await c.text(B7, name, pad, 127, size, TXT);
  } else c.line(pad, 129, pad + 140, 129, 0.6, LINE); // blank area for handwriting

  c.star(W - pad - 3.5, 124.5, 4, SKY);
  await c.text(B4, 'MEMBER', W - pad - 10, 127, 5.2, LABEL, { align: 'right', spacing: 1.3 });
  await c.text(B4, 'magical.am', W - pad, 141, 5, LABEL, { align: 'right', spacing: 0.4 });
  c.restore();
}

export async function renderPioneerCardPdf(card) {
  const sink = bufferSink();
  const doc = new PdfDoc(sink, { title: `Magical Pioneer Card ${formatNo(card.number)}`, width: CARD_W, height: CARD_H });
  await doc.start();
  const c = new Canvas(doc);
  await drawCardFront(doc, c, card);
  await doc.addPage(c.toString());
  await doc.end();
  return sink.result();
}
