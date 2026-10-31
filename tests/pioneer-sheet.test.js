import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { start } from './helpers.js';
import { renderPioneerSheetPdf, SHEET } from '../server/pdf/pioneer-sheet.js';
import { renderPioneerCardPdf, CARD_W, CARD_H } from '../server/pdf/pioneer-card.js';

const MM = 72 / 25.4;
const card = (n) => ({ number: String(20000000 + n * 1234567).slice(0, 8), firstName: 'Anna-Mariam', lastName: 'Melik-Shahnazaryan' + 'ABCDEFGH'[n % 8], cvv: String((n * 137) % 1000).padStart(3, '0') });
const cards = (n) => Array.from({ length: n }, (_, i) => card(i + 1));

// Reads a PDF made by server/pdf/writer.js: catalog, pages, placed cards (unit canvas through the CTM) and every text
// run with its page-space box (mm from the top-left corner; width from the embedded font metrics).
function parse(buf) {
  const raw = buf.toString('latin1');
  const objs = new Map();
  for (const m of raw.matchAll(/(\d+) 0 obj\n/g)) objs.set(Number(m[1]), m.index + m[0].length);
  const dict = (id) => raw.slice(objs.get(id), raw.indexOf('endobj', objs.get(id)));
  const stream = (id) => {
    const at = objs.get(id), d = raw.slice(at, raw.indexOf('stream\n', at)), len = Number(/\/Length (\d+)/.exec(d)[1]), s = at + d.length + 7;
    const data = buf.subarray(s, s + len);
    return (/\/FlateDecode/.test(d) ? inflateSync(data) : data).toString('latin1');
  };
  const fonts = new Map([...(/\/Font << ([^>]*) >>/.exec(dict(Number(/\/Resources (\d+) 0 R/.exec(raw)[1])))?.[1] || '').matchAll(/\/(F\d+) (\d+) 0 R/g)].map(([, name, id]) => {
    const t0 = dict(Number(id)), cmap = stream(Number(/\/ToUnicode (\d+) 0 R/.exec(t0)[1]));
    const cid = dict(Number(/\/DescendantFonts \[(\d+) 0 R\]/.exec(t0)[1]));
    const W = new Map([...(/\/W \[(.*)\] >>/.exec(cid)?.[1] || '').matchAll(/(\d+) \[([\d.]+)\]/g)].map(([, g, w]) => [Number(g), Number(w)]));
    return [name, { uni: new Map([...cmap.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/g)].map(([, g, u]) => [g, String.fromCharCode(...u.match(/.{4}/g).map((x) => parseInt(x, 16)))])), W }];
  }));
  const catalog = /\/Type \/Catalog[^\n]*/.exec(raw)[0];
  const fs = (SHEET.CW * MM) / CARD_W;
  const pages = [...raw.matchAll(/\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[([^\]]+)\] \/Resources \d+ 0 R \/Contents (\d+) 0 R/g)].map(([, box, cid]) => {
    const size = box.trim().split(/\s+/).map(Number).slice(2).map((v) => v / MM), H = size[1];
    const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    const pt = (m, x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];
    const toMm = ([x, y]) => [x / MM, H - y / MM];
    let ctm = [1, 0, 0, 1, 0, 0], font = null, size_ = 0, tc = 0; const st = [], placed = [], runs = [], args = [];
    for (const t of stream(Number(cid)).match(/<[0-9a-f]*>|\/[^\s/<>[\]]+|[^\s<>[\]]+/g) || []) {
      if (/^[-\d.]+$/.test(t) || t[0] === '/' || t[0] === '<') { args.push(t); continue; }
      if (t === 'q') st.push(ctm);
      else if (t === 'Q') ctm = st.pop();
      else if (t === 'cm') {
        const m = args.slice(-6).map(Number); ctm = mul(m, ctm);
        if (m[1] === 0 && m[2] === 0 && m[0] === m[3] && Math.abs(m[0] - fs) < 1e-5) {
          const [a, b] = [pt(ctm, 0, 0), pt(ctm, CARD_W, CARD_H)].map(toMm);
          placed.push({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]), uniform: Math.abs(ctm[0] - ctm[3]) < 1e-9 });
        }
      } else if (t === 'Tf') { font = fonts.get(args[args.length - 2].slice(1)); size_ = Number(args[args.length - 1]); }
      else if (t === 'Tc') tc = Number(args[args.length - 1]);
      else if (t === 'Td') { const [x, y] = args.slice(-2).map(Number); runs.push({ at: [x, y], ctm, size: size_, tc, font, gids: [] }); }
      else if (t === 'Tj') runs[runs.length - 1].gids.push(...args[args.length - 1].slice(1, -1).match(/.{4}/g));
      args.length = 0;
    }
    // merge consecutive runs drawn as one string (font fallback splits a string into several Td/Tj)
    const out = [];
    for (const r of runs) {
      const s = r.gids.map((g) => r.font.uni.get(g) ?? '?').join('');
      const w = r.gids.reduce((a, g) => a + (r.font.W.get(parseInt(g, 16)) ?? 600) * r.size / 1000 + r.tc, 0);
      const [x1, y1] = toMm(pt(r.ctm, r.at[0], r.at[1])), [x2] = toMm(pt(r.ctm, r.at[0] + w, r.at[1]));
      const hMm = (r.size * Math.abs(r.ctm[3])) / MM;
      out.push({ s, x1, x2, base: y1, top: y1 - hMm * 0.75 });
    }
    return { size, placed, runs: out };
  });
  return { catalog, pages };
}
const inside = (r, c, m = 0) => r.x1 >= c.x + m - 1e-6 && r.x2 <= c.x + c.w - m + 1e-6 && r.top >= c.y + m - 1e-6 && r.base <= c.y + c.h - m + 1e-6;
const overlap = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.top < b.base && b.top < a.base;

test('print sheet: exactly ONE A4 portrait page for 1-8 cards; no back page, no duplex or tray instructions', async () => {
  for (const n of [1, 2, 3, 7, 8]) {
    const pdf = await renderPioneerSheetPdf(cards(n));
    const { catalog, pages } = parse(pdf);
    assert.equal(pages.length, 1, `${n} cards -> one page`);
    assert.equal((pdf.toString('latin1').match(/\/Type \/Page /g) || []).length, 1, 'one page object, no empty second page');
    assert.match(pdf.toString('latin1'), /\/Count 1 >>/);
    assert.ok(Math.abs(pages[0].size[0] - 210) < 1e-3 && Math.abs(pages[0].size[1] - 297) < 1e-3, 'A4 portrait');
    assert.match(catalog, /\/PrintScaling \/None/, '100 %, no fit-to-page');
    assert.doesNotMatch(catalog, /Duplex|PickTray|NumCopies/, 'no duplex / tray / copies instructions');
    assert.equal(pages[0].placed.length, n, `${n} card fronts`);
  }
  await assert.rejects(renderPioneerSheetPdf([]));
  await assert.rejects(renderPioneerSheetPdf(cards(9)));
});

test('print sheet: real card size, uniform scale, inside safe margins; each CVV small, readable, on its own card, overlapping nothing', async () => {
  const list = cards(8);
  const { pages: [p] } = parse(await renderPioneerSheetPdf(list));
  for (const [i, c] of p.placed.entries()) {
    assert.ok(c.uniform, 'no distortion');
    assert.ok(Math.abs(c.w - 90) < 1e-3 && Math.abs(c.w / c.h - 85.6 / 53.98) < 1e-3, `card ${i + 1}: 90 mm wide, ID-1 proportions (${c.w.toFixed(3)} x ${c.h.toFixed(3)} mm)`);
    for (const v of [c.x - SHEET.BLEED, c.y - SHEET.BLEED, 210 - (c.x + c.w + SHEET.BLEED), 297 - (c.y + c.h + SHEET.BLEED)]) assert.ok(v >= 5, `artwork ${v.toFixed(2)} mm from the sheet edge (>= 5 mm)`);
    const onCard = p.runs.filter((r) => r.x1 >= c.x - 0.01 && r.x2 <= c.x + c.w + 0.01 && r.base >= c.y && r.top <= c.y + c.h);
    const cvv = onCard.filter((r) => r.s === list[i].cvv);
    assert.equal(cvv.length, 1, `card ${i + 1}: its own CVV exactly once`);
    const label = onCard.find((r) => r.s === 'CVV');
    assert.ok(label && label.base < cvv[0].top, 'labelled «CVV» above the code');
    assert.ok(inside(cvv[0], c, 3) && inside(label, c, 3), 'CVV at least 3 mm inside the card edge');
    const hMm = cvv[0].base - cvv[0].top;
    assert.ok(hMm > 1.5 && hMm < 4, `CVV cap height ${hMm.toFixed(2)} mm: small but readable`);
    for (const other of onCard.filter((r) => r !== cvv[0] && r !== label)) {
      assert.ok(!overlap(cvv[0], other), `CVV does not overlap «${other.s}»`);
      assert.ok(!overlap(label, other), `CVV label does not overlap «${other.s}»`);
    }
    const no = onCard.find((r) => /^\d{4} \d{4}$/.test(r.s));
    assert.ok(no && cvv[0].x1 - no.x2 > 5, 'clear gap between card number and CVV');
    for (const o of list) if (o !== list[i]) assert.ok(!onCard.some((r) => r.s === o.cvv && o.cvv !== list[i].cvv), 'no other card\'s CVV on this card');
  }
});

test('single-card ID-1 PDF stays one page and never shows a CVV', async () => {
  const pdf = await renderPioneerCardPdf({ number: '12345678', firstName: 'Anna', lastName: 'Test' });
  const { catalog, pages } = parse(pdf);
  assert.equal(pages.length, 1);
  assert.ok(Math.abs(pages[0].size[0] - 85.6) < 0.01 && Math.abs(pages[0].size[1] - 53.98) < 0.01);
  assert.ok(!pages[0].runs.some((r) => r.s === 'CVV'), 'no CVV on the single-card page');
  assert.doesNotMatch(catalog, /Duplex|PickTray/);
});

test('admin print API: one page with every CVV; old duplex fields ignored; calibration route gone; admin UI has one print path', async () => {
  const s = await start();
  const l = await s.login();
  const call = (path, body) => s.api('/api/admin/pioneer' + path, { method: 'POST', body, cookie: l.cookie, csrf: l.csrf });
  const a = (await call('/cards', { firstName: 'Anna' })).data, b = (await call('/cards', { firstName: 'Lilit' })).data;
  // an old browser tab may still send flip/backOffset: accepted and ignored, still one page
  const r = await call('/cards/print-sheet', { cards: [{ id: a.card.id, cvv: a.cvv }, { id: b.card.id, cvv: b.cvv }], flip: 'short', backOffset: { x: 9, y: 'x' } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const { catalog, pages } = parse(r.data);
  assert.equal(pages.length, 1);
  assert.doesNotMatch(catalog, /Duplex|PickTray/);
  for (const c of [a, b]) assert.ok(pages[0].runs.some((x) => x.s === c.cvv), `CVV of ${c.card.number} on the page`);
  const gone = (await call('/cards/print-calibration', { flip: 'long' })).status;
  assert.ok([404, 405].includes(gone), `calibration (duplex) route removed: ${gone}`); // 405: the path only matches GET/PATCH /cards/:id
  const audit = (await s.q("SELECT details FROM pioneer_audit_log WHERE action = 'card.print' ORDER BY id")).rows;
  assert.deepEqual(audit.map((x) => Object.keys(x.details).sort()), [['batch', 'cvv', 'position'], ['batch', 'cvv', 'position']]);
  await s.close();
  const ui = readFileSync(new URL('../src/pages/admin-pioneer.js', import.meta.url), 'utf8');
  assert.ok(!/printCard\(|\/pdf`|window\.print\(|print-calibration|backOffset|flip/.test(ui), 'no other print template, no duplex options');
  assert.ok(/print-sheet/.test(ui));
});
