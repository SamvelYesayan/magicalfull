// A4 print sheet for 1-8 Pioneer Cards: ONE page, card fronts only, each front showing its own CVV.
// Grid 2 x 4, cards 90 x 56.75 mm (the ID-1 design from pioneer-card.js scaled uniformly), 8 mm gaps,
// 2 mm bleed, crop marks for used slots. Single-sided: no back page and no duplex settings, so any printer
// prints it as one ordinary A4 sheet. /PrintScaling /None asks viewers for 100 % (no fit-to-page).
import { PdfDoc, Canvas, bufferSink } from './writer.js';
import { getResources } from './ticket.js';
import { CARD_W, CARD_H, drawCardFront } from './pioneer-card.js';

const MM = 72 / 25.4;
export const SHEET = (() => {
  const PW = 210, PH = 297, CW = 90, CH = +(53.98 * 90 / 85.6).toFixed(4), GAP = 8, BLEED = 2;
  const X0 = (PW - (2 * CW + GAP)) / 2, Y0 = (PH - (4 * CH + 3 * GAP)) / 2;
  return { PW, PH, CW, CH, GAP, BLEED, X0, Y0, MAX: 8 };
})();
const { PW, PH, CW, CH, BLEED, X0, Y0, GAP } = SHEET;
/** Page position (mm, top-left) of slot i (row-major). */
export const slotPos = (i) => { const row = Math.floor(i / 2), col = i % 2; return { row, col, x: X0 + col * (CW + GAP), y: Y0 + row * (CH + GAP) }; };

const INK = [0, 0, 0], NOTE = [0.42, 0.41, 0.5];

function cropMarks(pg, used) {
  const off = 2.5, len = 3, L = (x1, y1, x2, y2) => pg.line(x1 * MM, y1 * MM, x2 * MM, y2 * MM, 0.3, INK);
  for (const { x, y } of used) {
    for (const cx of [x, x + CW]) { L(cx, y - off - len, cx, y - off); L(cx, y + CH + off, cx, y + CH + off + len); }
    for (const cy of [y, y + CH]) { L(x - off - len, cy, x - off, cy); L(x + CW + off, cy, x + CW + off + len, cy); }
  }
}

/**
 * cards: [{ number, firstName, lastName, cvv }] in print order (1..8). Card i goes to slot i (row-major);
 * unused slots stay blank. Always exactly one A4 portrait page.
 */
export async function renderPioneerSheetPdf(cards) {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > SHEET.MAX) throw new Error('1-8 cards required');
  const { B4, B7 } = getResources();
  const sink = bufferSink();
  const doc = new PdfDoc(sink, { title: `Magical Pioneer Cards (${cards.length})`, width: +(PW * MM).toFixed(4), height: +(PH * MM).toFixed(4), viewerPrefs: '/PrintScaling /None' });
  await doc.start();
  const pg = new Canvas(doc), used = [];
  const s = (CW * MM) / CARD_W; // uniform: 85.6 mm design -> 90 mm wide
  for (let i = 0; i < cards.length; i++) {
    const p = slotPos(i), sub = new Canvas(doc);
    sub.H = CARD_H;
    await drawCardFront(doc, sub, cards[i], (BLEED * MM) / s);
    pg.add(`q ${s.toFixed(6)} 0 0 ${s.toFixed(6)} ${(p.x * MM).toFixed(3)} ${((PH - p.y - CH) * MM).toFixed(3)} cm`).add(sub.toString()).add('Q');
    used.push(p);
  }
  cropMarks(pg, used);
  await pg.text(B7, `MAGICAL PIONEER CARD  ·  A4  ·  ՄԻԱԿՈՂՄԱՆԻ  ·  ՄԱՍՇՏԱԲ 100% (ACTUAL SIZE)  ·  ${cards.length} ՔԱՐՏ`, (PW / 2) * MM, 16.2 * MM, 5.2, NOTE, { align: 'center', spacing: 0.4 });
  await pg.text(B4, '90 × 56.75 ՄՄ  ·  2 ՄՄ ԵԶՐԱՅԻՆ ՊԱՇԱՐ (BLEED)  ·  ԿՏՐԵԼ ԿՏՐՄԱՆ ՆՇԱՆՆԵՐՈՎ', (PW / 2) * MM, (PH - 14.2) * MM, 4.6, NOTE, { align: 'center', spacing: 0.3 });
  await doc.addPage(pg.toString());
  await doc.end();
  return sink.result();
}
