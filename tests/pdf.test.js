import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getResources, renderInvitationPdf } from '../server/pdf/ticket.js';
import { EVENT } from '../shared/event.js';

test('fonts cover the complete Armenian alphabet, digits, Latin and Cyrillic used in names/ticket', () => {
  const { B4, B7, DISP } = getResources();
  const cps = [];
  for (let c = 0x531; c <= 0x556; c++) cps.push(c);
  for (let c = 0x561; c <= 0x586; c++) cps.push(c);
  cps.push(0x589, 0xab, 0xbb, 0x2d, 0x27, 0x2019, 0x2e, 0x3a, 0x20);
  for (const ch of '0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÜüÑñ' + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюяЁё') cps.push(ch.codePointAt(0));
  for (const stack of [B4, B7, DISP]) for (const cp of cps) assert.ok(stack.has(cp), `${String.fromCodePoint(cp)} U+${cp.toString(16)} missing`);
  for (const t of [EVENT.name, EVENT.location, EVENT.giftsNote, EVENT.dateText, 'ՀՐԱՎԻՐՎՈՒՄ Է', 'ԱՄՍԱԹԻՎ', 'ԺԱՄ', 'ՎԱՅՐ', 'ՀՐԱՎԻՐԱՏՈՄՍ', 'ՀՐԱՎԻՐԱՏՈՄՍԻ ՀԱՄԱՐ'])
    for (const ch of t) assert.ok(B7.has(ch.codePointAt(0)) && B4.has(ch.codePointAt(0)), `ticket text char ${ch} missing`);
});

test('PDF text layer round-trips Armenian, Cyrillic and Latin names (poppler, if installed)', async (t) => {
  if (spawnSync('pdftotext', ['-v']).error) return t.skip('pdftotext not installed');
  const dir = mkdtempSync(join(tmpdir(), 'mg-'));
  const f = join(dir, 't.pdf');
  writeFileSync(f, await renderInvitationPdf({ firstName: 'Աննա-Մարիամ', lastName: 'Մելիք-Շահնազարյան', invitationNo: 'MGC-7K4P2Q' }));
  const text = execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' });
  for (const s of ['Աննա-Մարիամ Մելիք-Շահնազարյան', 'MGC-7K4P2Q', `«${EVENT.name}»`, EVENT.dateText, EVENT.time, 'Գագարին ավանի', EVENT.giftsNote, 'MAGICAL']) assert.ok(text.includes(s), `missing: ${s}`);
  writeFileSync(f, await renderInvitationPdf({ firstName: 'Иван', lastName: 'Ñandú', invitationNo: 'MGC-ABCDEF' }));
  assert.ok(execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }).includes('Иван Ñandú'));
  const info = execFileSync('pdffonts', [f], { encoding: 'utf8' });
  for (const line of info.split('\n').slice(2).filter(Boolean)) assert.match(line, /\byes\b/, 'every font must be embedded: ' + line);
  assert.equal(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)[1], '1');
});

test('PDF contains no unwritten objects and a valid xref', async () => {
  const buf = await renderInvitationPdf({ firstName: 'Աննա', lastName: 'Գրիգորյան', invitationNo: 'MGC-ABCDEF' });
  const s = buf.toString('latin1');
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)[1]);
  assert.equal(s.slice(start, start + 4), 'xref');
  const m = /xref\n0 (\d+)\n/.exec(s.slice(start));
  const n = Number(m[1]);
  const entries = s.slice(start + m[0].length).split('\n').slice(0, n);
  entries.slice(1).forEach((e, i) => { const off = Number(e.slice(0, 10)); assert.ok(s.startsWith(`${i + 1} 0 obj`, off), `obj ${i + 1} offset`); });
});
