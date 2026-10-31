import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { start } from './helpers.js';
import { SHEET } from '../server/pdf/pioneer-sheet.js';

const A = '/api/admin/pioneer';
const MM = 72 / 25.4;

async function admin(s) {
  const l = await s.login();
  return { ...l, call: (path, opts = {}) => s.api(A + path, { cookie: l.cookie, csrf: l.csrf, ...opts }) };
}
async function newCard(ad, holder = {}) {
  const r = await ad.call('/cards', { method: 'POST', body: holder });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { ...r.data.card, cvv: r.data.cvv };
}
const wrongCvv = (cvv) => String((Number(cvv) + 1) % 1000).padStart(3, '0');
const print = (ad, cards) => ad.call('/cards/print-sheet', { method: 'POST', body: { cards: cards.map((c) => ({ id: c.id, cvv: c.cvv })) } });

// Minimal reader for the PDFs our writer produces: every text run with its absolute position (pt, origin
// bottom-left), per page. Follows q/Q/cm, so card placement and the 180 deg short-edge page are applied.
function pdfText(buf) {
  const raw = buf.toString('latin1');
  const objs = new Map();
  for (const m of raw.matchAll(/(\d+) 0 obj\n/g)) objs.set(Number(m[1]), m.index + m[0].length);
  const dict = (id) => raw.slice(objs.get(id), raw.indexOf('endobj', objs.get(id)));
  const stream = (id) => {
    const d = dict(id), len = Number(/\/Length (\d+)/.exec(d)[1]), s = objs.get(id) + d.indexOf('stream\n') + 7;
    const data = buf.subarray(s, s + len);
    return (/\/FlateDecode/.test(d) ? inflateSync(data) : data).toString('latin1');
  };
  const res = /\/Font << ([^>]*) >>/.exec(dict(Number(/\/Resources (\d+) 0 R/.exec(raw)[1])))[1];
  const fonts = new Map([...res.matchAll(/\/(F\d+) (\d+) 0 R/g)].map(([, name, id]) => {
    const cmap = stream(Number(/\/ToUnicode (\d+) 0 R/.exec(dict(Number(id)))[1]));
    return [name, new Map([...cmap.matchAll(/<([0-9a-f]{4})> <([0-9a-f]+)>/g)].map(([, g, u]) => [g, String.fromCharCode(...u.match(/.{4}/g).map((x) => parseInt(x, 16)))]))];
  }));
  const pages = [...raw.matchAll(/\/Type \/Page \/Parent \d+ 0 R \/MediaBox \[([^\]]+)\] \/Resources \d+ 0 R \/Contents (\d+) 0 R/g)];
  return pages.map(([, box, cid]) => {
    const runs = [];
    let ctm = [1, 0, 0, 1, 0, 0], font = null;
    const stack = [];
    const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
    const toks = stream(Number(cid)).match(/<[0-9a-f]*>|\/[^\s/<>[\]]+|[^\s<>[\]]+/g) || [];
    const args = [];
    for (const t of toks) {
      if (/^[-\d.]+$/.test(t) || t[0] === '/' || t[0] === '<') { args.push(t); continue; }
      if (t === 'q') stack.push(ctm);
      else if (t === 'Q') ctm = stack.pop();
      else if (t === 'cm') ctm = mul(args.slice(-6).map(Number), ctm);
      else if (t === 'Tf') font = fonts.get(args[args.length - 2].slice(1));
      else if (t === 'Td') { const [x, y] = args.slice(-2).map(Number); runs.push({ x: x * ctm[0] + y * ctm[2] + ctm[4], y: x * ctm[1] + y * ctm[3] + ctm[5], s: '' }); }
      else if (t === 'Tj') runs[runs.length - 1].s += args[args.length - 1].slice(1, -1).match(/.{4}/g).map((g) => font.get(g) ?? '?').join('');
      args.length = 0;
    }
    return { size: box.trim().split(/\s+/).map(Number), runs };
  });
}
// Physical slot (row, col) of a point on the sheet, or null when outside every card.
function slotAt({ x, y }) {
  const mx = x / MM, my = SHEET.PH - y / MM; // mm from the top-left
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
    const sx = SHEET.X0 + c * (SHEET.CW + SHEET.GAP), sy = SHEET.Y0 + r * (SHEET.CH + SHEET.GAP);
    if (mx >= sx && mx <= sx + SHEET.CW && my >= sy && my <= sy + SHEET.CH) return `${r},${c}`;
  }
  return null;
}
// For each slot: the card numbers / CVVs drawn inside it.
function bySlot(page) {
  const out = {};
  for (const r of page.runs) {
    const k = slotAt(r);
    if (!k) continue;
    (out[k] ||= []).push(r.s);
  }
  return out;
}
const fmt = (n) => `${n.slice(0, 4)} ${n.slice(4)}`;
const holderName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ');

test('print sheet: admin session + CSRF required; cardholders and anonymous callers get nothing', async () => {
  const s = await start();
  assert.equal((await s.api(A + '/cards/print-sheet', { method: 'POST', body: { cards: [] } })).status, 401);
  const ad = await admin(s);
  const c = await newCard(ad);
  assert.equal((await s.api(A + '/cards/print-sheet', { method: 'POST', body: { cards: [{ id: c.id, cvv: c.cvv }] }, cookie: ad.cookie })).status, 403, 'CSRF token required');
  const h = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: c.number, cvv: c.cvv } });
  const hc = (h.headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await s.api(A + '/cards/print-sheet', { method: 'POST', body: { cards: [{ id: c.id, cvv: c.cvv }] }, cookie: hc, csrf: h.data.csrfToken })).status, 401, 'cardholder session is not an admin session');
  assert.equal((await s.api(A + '/cards/print-sheet')).status, 401);
  assert.equal((await ad.call('/cards/print-sheet')).status, 404, 'no GET route even for admins: nothing card-related is readable by URL');
  await s.close();
});

test('print sheet: 1-8 cards, distinct, active, each with a 3-digit CVV; validation never prints anything', async () => {
  const s = await start();
  const ad = await admin(s);
  const cards = [];
  for (let i = 0; i < 9; i++) cards.push(await newCard(ad, { firstName: 'Nm' + 'ABCDEFGHIJK'[i] }));
  const r0 = await print(ad, []);
  assert.equal(r0.status, 422); assert.ok(r0.data.error.fields.cards);
  const r9 = await print(ad, cards);
  assert.equal(r9.status, 422, 'a ninth card is refused'); assert.match(r9.data.error.fields.cards, /8/);
  assert.equal((await print(ad, [cards[0], cards[0]])).status, 422, 'duplicates refused');
  const noCvv = await print(ad, [cards[0], { id: cards[1].id, cvv: '12' }]);
  assert.equal(noCvv.status, 422); assert.deepEqual(Object.keys(noCvv.data.error.fields), [`cvv.${cards[1].id}`]);
  assert.equal((await print(ad, [{ id: 'x', cvv: '000' }])).status, 422);
  const ghost = await print(ad, [cards[0], { id: 999999, cvv: '000' }]);
  assert.equal(ghost.status, 404); assert.ok(ghost.data.error.fields['card.999999']);
  await ad.call(`/cards/${cards[2].id}/status`, { method: 'POST', body: { status: 'inactive' } });
  const off = await print(ad, [cards[2]]);
  assert.equal(off.status, 422); assert.ok(off.data.error.fields[`card.${cards[2].id}`]);
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'card.print'")).rows[0].c, 0);
  await s.close();
});

test('print sheet: a wrong CVV is rejected per card against the stored hash, nothing changes, guessing is capped', async () => {
  const s = await start();
  const ad = await admin(s);
  const a = await newCard(ad), b = await newCard(ad);
  const before = (await s.q('SELECT id, cvv_hash, cvv_reset_at, balance, status FROM pioneer_cards ORDER BY id')).rows;
  const r = await print(ad, [a, { id: b.id, cvv: wrongCvv(b.cvv) }]);
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'cvv_mismatch');
  assert.deepEqual(Object.keys(r.data.error.fields), [`cvv.${b.id}`], 'only the wrong card is flagged');
  assert.ok(!JSON.stringify(r.data).includes(b.cvv) && !JSON.stringify(r.data).includes(wrongCvv(b.cvv)), 'codes are never echoed');
  assert.deepEqual((await s.q('SELECT id, cvv_hash, cvv_reset_at, balance, status FROM pioneer_cards ORDER BY id')).rows, before, 'card records untouched');
  const miss = (await s.q("SELECT card_id, details FROM pioneer_audit_log WHERE action = 'card.print_cvv_mismatch'")).rows;
  assert.deepEqual(miss.map((x) => x.card_id), [b.id]);
  assert.ok(!JSON.stringify(miss).match(/\d{3}"/), 'no code in the audit log');
  // 5 wrong codes in an hour block the card here, even for the right code (no guessing oracle)
  for (let i = 0; i < 4; i++) assert.equal((await print(ad, [{ id: b.id, cvv: wrongCvv(b.cvv) }])).status, 422);
  const blocked = await print(ad, [b]);
  assert.equal(blocked.status, 429); assert.ok(blocked.data.error.fields[`cvv.${b.id}`]);
  assert.equal((await print(ad, [a])).status, 200, 'other cards are not affected');
  await s.close();
});

test('print sheet: arbitrary selections print exactly those cards, in order, each front with its own CVV on ONE page', async () => {
  const s = await start();
  const ad = await admin(s);
  const all = [];
  for (let i = 0; i < 11; i++) all.push(await newCard(ad, { firstName: 'Holder' + 'ABCDEFGHIJK'[i], lastName: i % 2 ? 'Yesayan' : 'Tovmasyan' }));
  // force at least one CVV with a leading zero: reset until the issued code starts with 0 (test DB only)
  let z = all[9];
  for (let k = 0; k < 200 && !z.cvv.startsWith('0'); k++) z = { ...z, cvv: (await ad.call(`/cards/${z.id}/cvv`, { method: 'POST', body: {} })).data.cvv };
  all[9] = z;
  const before = (await s.q('SELECT id, cvv_hash, balance, status, first_name FROM pioneer_cards ORDER BY id')).rows;
  const txBefore = (await s.q('SELECT COUNT(*)::int AS c FROM pioneer_transactions')).rows[0].c;

  const cases = [
    [all[6]],
    [all[9], all[2], all[10]],
    [all[1], all[3], all[5], all[7], all[9], all[0], all[10], all[8]],
    [all[4], all[2], all[9]],
  ];
  for (const pick of cases) {
    const r = await print(ad, pick);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.match(r.headers.get('content-type'), /application\/pdf/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    assert.ok(!/\d{3}/.test(r.headers.get('content-disposition').replace(/\d{4}-\d{2}-\d{2}/, '')), 'no CVV-like value in the file name');
    const pages = pdfText(r.data);
    assert.equal(pages.length, 1, 'exactly one page, no back page');
    assert.deepEqual(pages[0].size.map((v) => Math.round(v / MM)), [0, 0, 210, 297], 'A4 portrait');
    const front = bySlot(pages[0]);
    assert.equal(Object.keys(front).length, pick.length, 'only the selected cards, unused slots blank');
    pick.forEach((c, i) => {
      const f = front[`${Math.floor(i / 2)},${i % 2}`];
      assert.ok(f?.includes(fmt(c.number)) && f.includes(holderName(c)) && f.includes(c.cvv), `slot ${i + 1}: ${c.number}, its holder and its own CVV`);
      for (const other of all) if (other.id !== c.id) assert.ok(!f.includes(fmt(other.number)), 'no other card in this slot');
    });
    const numbersOnSheet = pages[0].runs.map((x) => x.s).filter((x) => /^\d{4} \d{4}$/.test(x));
    assert.deepEqual(numbersOnSheet.sort(), pick.map((c) => fmt(c.number)).sort(), 'each selected number exactly once');
  }
  assert.ok(all[9].cvv.startsWith('0'), 'leading-zero CVV covered');
  const audit = (await s.q("SELECT card_id, details FROM pioneer_audit_log WHERE action = 'card.print' ORDER BY id")).rows;
  assert.equal(audit.length, cases.reduce((n, x) => n + x.length, 0));
  assert.deepEqual(audit.slice(1, 4).map((x) => [x.card_id, x.details.position, x.details.batch]), [[all[9].id, 1, 3], [all[2].id, 2, 3], [all[10].id, 3, 3]]);
  assert.ok(!JSON.stringify(audit).match(/"\d{3}"/) && audit.every((a) => a.details.cvv === 'entered'), 'audit records only where the code came from, never the code');
  assert.deepEqual((await s.q('SELECT id, cvv_hash, balance, status, first_name FROM pioneer_cards ORDER BY id')).rows, before, 'printing never modifies cards');
  assert.equal((await s.q('SELECT COUNT(*)::int AS c FROM pioneer_transactions')).rows[0].c, txBefore);
  await s.close();
});

// ---------- automatic CVV (encrypted copy made when the code is issued; migration 004) ----------
const PEPPER = 'p'.repeat(48);
const printAuto = (ad, cards) => ad.call('/cards/print-sheet', { method: 'POST', body: { cards: cards.map((c) => ({ id: c.id })) } });
// card number -> the CVV printed on that card's front (one page)
const sheetCvvs = (pdf) => {
  const pages = pdfText(pdf);
  assert.equal(pages.length, 1, 'one page');
  return Object.fromEntries(Object.values(bySlot(pages[0])).map((runs) => [runs.find((x) => /^\d{4} \d{4}$/.test(x)), runs.find((x) => /^\d{3}$/.test(x))]));
};

test('automatic CVV: issued codes are kept encrypted per card and printed without typing, never sent to the browser', async () => {
  const s = await start({ pioneerPepper: PEPPER });
  const ad = await admin(s);
  const cards = [];
  for (let i = 0; i < 9; i++) cards.push(await newCard(ad, { firstName: 'Auto' + 'ABCDEFGHI'[i] }));
  for (const c of cards) assert.equal(c.cvvOnFile, true);
  const rows = (await s.q('SELECT id, card_no, cvv_enc FROM pioneer_cards ORDER BY id')).rows;
  for (const r of rows) {
    const c = cards.find((x) => x.id === r.id);
    assert.match(r.cvv_enc, /^v1\./);
    assert.ok(!r.cvv_enc.includes(c.cvv), 'not stored in plain text');
  }
  assert.equal(new Set(rows.map((r) => r.cvv_enc)).size, rows.length, 'random IV: no two ciphertexts alike');
  // admin API responses expose only the flag
  for (const r of [await ad.call('/cards?pageSize=100'), await ad.call(`/cards/${cards[0].id}`)]) {
    const body = JSON.stringify(r.data);
    assert.ok(!body.includes('cvv_enc') && !rows.some((x) => body.includes(x.cvv_enc)), 'ciphertext never leaves the server');
    for (const c of cards) assert.ok(!body.includes(`"${c.cvv}"`), 'no code in the response');
  }

  // one card, then eight in an arbitrary order: every front carries its own card's code
  const one = await printAuto(ad, [cards[4]]);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  assert.deepEqual(sheetCvvs(one.data), { [fmt(cards[4].number)]: cards[4].cvv });
  const pick = [cards[7], cards[2], cards[8], cards[0], cards[5], cards[3], cards[6], cards[1]];
  const r8 = await printAuto(ad, pick);
  assert.equal(r8.status, 200);
  assert.deepEqual(sheetCvvs(r8.data), Object.fromEntries(pick.map((c) => [fmt(c.number), c.cvv])), 'CVV-to-card matching');
  // a CVV reset replaces the stored copy: the sheet prints the new code, never the old one
  const fresh = (await ad.call(`/cards/${cards[2].id}/cvv`, { method: 'POST', body: {} })).data.cvv;
  const after = await printAuto(ad, [cards[2]]);
  assert.deepEqual(sheetCvvs(after.data), { [fmt(cards[2].number)]: fresh });
  const audit = (await s.q("SELECT details FROM pioneer_audit_log WHERE action = 'card.print'")).rows;
  assert.ok(audit.every((a) => a.details.cvv === 'stored'));
  assert.ok(!JSON.stringify(audit).match(/"\d{3}"/), 'codes never in the audit log');
  await s.close();
});

test('automatic CVV: unavailable for cards issued without a stored copy; nothing printed; typed code still works', async () => {
  const s = await start({ pioneerPepper: PEPPER });
  const ad = await admin(s);
  const a = await newCard(ad, { firstName: 'Kept' }), old = await newCard(ad, { firstName: 'Legacy' }), b = await newCard(ad, { firstName: 'Other' });
  // a card from before migration 004 has only the hash (test database only)
  await s.q('UPDATE pioneer_cards SET cvv_enc = NULL WHERE id = $1', [old.id]);
  assert.equal((await ad.call(`/cards/${old.id}`)).data.card.cvvOnFile, false);
  const r = await printAuto(ad, [a, old]);
  assert.equal(r.status, 422); assert.equal(r.data.error.code, 'cvv_unavailable');
  assert.deepEqual(Object.keys(r.data.error.fields), [`cvv.${old.id}`], 'only the card without a stored code is flagged');
  assert.ok(!JSON.stringify(r.data).includes(a.cvv) && !JSON.stringify(r.data).includes(old.cvv));
  assert.equal((await s.q("SELECT COUNT(*)::int AS c FROM pioneer_audit_log WHERE action = 'card.print'")).rows[0].c, 0, 'nothing printed');
  // mixed sheet: stored code for one card, typed (and verified) code for the old one
  const mixed = await ad.call('/cards/print-sheet', { method: 'POST', body: { cards: [{ id: a.id }, { id: old.id, cvv: old.cvv }] } });
  assert.equal(mixed.status, 200);
  assert.deepEqual(sheetCvvs(mixed.data), { [fmt(a.number)]: a.cvv, [fmt(old.number)]: old.cvv });
  assert.deepEqual((await s.q("SELECT details->>'cvv' AS src FROM pioneer_audit_log WHERE action = 'card.print' ORDER BY id")).rows.map((x) => x.src), ['stored', 'entered']);
  // a stored copy moved to another card does not open there (bound to the card number): no mix-up possible
  await s.q('UPDATE pioneer_cards SET cvv_enc = (SELECT cvv_enc FROM pioneer_cards WHERE id = $1) WHERE id = $2', [a.id, b.id]);
  const moved = await printAuto(ad, [b]);
  assert.equal(moved.status, 422); assert.ok(moved.data.error.fields[`cvv.${b.id}`]);
  await s.close();
});

test('automatic CVV is off without PIONEER_CVV_PEPPER: nothing is stored, the admin types the code', async () => {
  const s = await start(); // test config has no pepper
  const ad = await admin(s);
  const c = await newCard(ad);
  assert.equal(c.cvvOnFile, false);
  assert.equal((await s.q('SELECT cvv_enc FROM pioneer_cards WHERE id = $1', [c.id])).rows[0].cvv_enc, null);
  assert.equal((await printAuto(ad, [c])).data.error.code, 'cvv_unavailable');
  assert.equal((await print(ad, [c])).status, 200);
  await s.close();
});

test('older cards: a typed code that matches the hash can be kept for next time, without a CVV change or sign-out', async () => {
  const s = await start({ pioneerPepper: PEPPER });
  const ad = await admin(s);
  const old = await newCard(ad, { firstName: 'Legacy' }), other = await newCard(ad, { firstName: 'Other' });
  await s.q('UPDATE pioneer_cards SET cvv_enc = NULL WHERE id = ANY($1::int[])', [[old.id, other.id]]); // as before migration 004 (test DB)
  // the cardholder is signed in with the code they already have
  const login = await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: old.number, cvv: old.cvv } });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const hashBefore = (await s.q('SELECT cvv_hash, cvv_reset_at, updated_at FROM pioneer_cards WHERE id = $1', [old.id])).rows[0];

  // without the option nothing is kept
  const plain = await ad.call('/cards/print-sheet', { method: 'POST', body: { cards: [{ id: old.id, cvv: old.cvv }] } });
  assert.equal(plain.status, 200); assert.equal(plain.headers.get('x-pioneer-cvv-kept'), '0');
  assert.equal((await s.q('SELECT cvv_enc FROM pioneer_cards WHERE id = $1', [old.id])).rows[0].cvv_enc, null);
  // a wrong code is never kept (and nothing is printed)
  const bad = await ad.call('/cards/print-sheet', { method: 'POST', body: { keepEntered: true, cards: [{ id: other.id, cvv: wrongCvv(other.cvv) }] } });
  assert.equal(bad.status, 422);
  assert.equal((await s.q('SELECT cvv_enc FROM pioneer_cards WHERE id = $1', [other.id])).rows[0].cvv_enc, null);
  // with the option: the verified code is kept, encrypted
  const kept = await ad.call('/cards/print-sheet', { method: 'POST', body: { keepEntered: true, cards: [{ id: old.id, cvv: old.cvv }] } });
  assert.equal(kept.status, 200); assert.equal(kept.headers.get('x-pioneer-cvv-kept'), '1');
  const row = (await s.q('SELECT cvv_enc, cvv_hash, cvv_reset_at, updated_at FROM pioneer_cards WHERE id = $1', [old.id])).rows[0];
  assert.match(row.cvv_enc, /^v1\./); assert.ok(!row.cvv_enc.includes(old.cvv));
  assert.deepEqual({ h: row.cvv_hash, r: row.cvv_reset_at, u: row.updated_at }, { h: hashBefore.cvv_hash, r: hashBefore.cvv_reset_at, u: hashBefore.updated_at }, 'CVV unchanged, not a reset');
  assert.equal((await s.api('/api/pioneer/me', { cookie })).status, 200, 'cardholder stays signed in');
  assert.equal((await s.api('/api/pioneer/login', { method: 'POST', body: { cardNumber: old.number, cvv: old.cvv } })).status, 200, 'their code still works');
  assert.equal((await ad.call(`/cards/${old.id}`)).data.card.cvvOnFile, true);
  // next time: automatic, same code on the card
  const auto = await printAuto(ad, [old]);
  assert.equal(auto.status, 200);
  assert.deepEqual(sheetCvvs(auto.data), { [fmt(old.number)]: old.cvv });
  const a = (await s.q("SELECT action, details FROM pioneer_audit_log WHERE card_id = $1 AND action LIKE 'card.%' ORDER BY id", [old.id])).rows;
  assert.deepEqual(a.filter((x) => x.action === 'card.cvv_stored').length, 1);
  assert.ok(!JSON.stringify(a).match(/"\d{3}"/), 'no code in the audit log');
  await s.close();
});
