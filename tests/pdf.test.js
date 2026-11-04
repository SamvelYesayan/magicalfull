import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getResources } from '../server/pdf/ticket.js';
import { renderPioneerCardPdf } from '../server/pdf/pioneer-card.js';

test('fonts cover the complete Armenian alphabet, digits, Latin and Cyrillic used in names', () => {
  const { B4, B7, DISP } = getResources();
  const cps = [];
  for (let c = 0x531; c <= 0x556; c++) cps.push(c);
  for (let c = 0x561; c <= 0x586; c++) cps.push(c);
  cps.push(0x589, 0xab, 0xbb, 0x2d, 0x27, 0x2019, 0x2e, 0x3a, 0x20);
  for (const ch of '0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÜüÑñ' + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁё') cps.push(ch.codePointAt(0));
  for (const stack of [B4, B7, DISP]) for (const cp of cps) assert.ok(stack.has(cp), `${String.fromCodePoint(cp)} U+${cp.toString(16)} missing`);
});

test('PDF text layer is extractable and every font is embedded (poppler, if installed)', async (t) => {
  if (['pdftotext', 'pdffonts', 'pdfinfo'].some((x) => spawnSync(x, ['-v']).error)) return t.skip('poppler tools not installed');
  const dir = mkdtempSync(join(tmpdir(), 'mg-'));
  const f = join(dir, 't.pdf');
  writeFileSync(f, await renderPioneerCardPdf({ number: '12345678', firstName: 'Աննա', lastName: 'Գրիգորյան' }));
  const text = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' });
  for (const t of ['PIONEER CARD', 'CARD NUMBER', '1234 5678']) assert.ok(text.includes(t), 'missing: ' + t);
  const info = execFileSync('pdffonts', [f], { encoding: 'utf8' });
  for (const line of info.split('\n').slice(2).filter(Boolean)) assert.match(line, /\byes\b/, 'every font must be embedded: ' + line);
  assert.equal(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1], '1');
});

test('PDF contains no unwritten objects and a valid xref', async () => {
  const buf = await renderPioneerCardPdf({ number: '12345678', firstName: 'Աննա', lastName: 'Գրիգորյան' });
  const s = buf.toString('latin1');
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
  assert.equal(s.slice(start, start + 4), 'xref');
  const m = /xref\n0 (\d+)\n/.exec(s.slice(start));
  const n = Number(m[1]);
  const entries = s.slice(start + m[0].length).split('\n').slice(0, n);
  entries.slice(1).forEach((e, i) => { const off = Number(e.slice(0, 10)); assert.ok(s.startsWith(`${i + 1} 0 obj`, off), `obj ${i + 1} offset`); });
});
