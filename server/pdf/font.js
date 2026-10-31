// Minimal TrueType loader: WOFF1 -> sfnt, cmap, metrics. No dependencies.
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

function checksum(d) {
  let s = 0;
  for (let i = 0; i < d.length; i += 4) {
    let v = 0;
    for (let k = 0; k < 4; k++) v = v * 256 + (i + k < d.length ? d[i + k] : 0);
    s = (s + v) % 4294967296;
  }
  return s;
}

export function woffToSfnt(buf) {
  if (buf.toString('latin1', 0, 4) !== 'wOFF') throw new Error('Not a WOFF file');
  const flavor = buf.readUInt32BE(4);
  const n = buf.readUInt16BE(12);
  const tabs = [];
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20;
    const tag = buf.toString('latin1', o, o + 4);
    const off = buf.readUInt32BE(o + 4), comp = buf.readUInt32BE(o + 8), orig = buf.readUInt32BE(o + 12);
    let data = buf.subarray(off, off + comp);
    if (comp < orig) data = inflateSync(data);
    if (data.length !== orig) throw new Error('Corrupt WOFF table ' + tag);
    tabs.push({ tag, data });
  }
  if (tabs.some((t) => t.tag === 'CFF ')) throw new Error('CFF-flavoured fonts are not supported');
  tabs.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const dir = Buffer.alloc(12 + n * 16);
  dir.writeUInt32BE(flavor, 0);
  dir.writeUInt16BE(n, 4);
  const es = Math.floor(Math.log2(n)), sr = (1 << es) * 16;
  dir.writeUInt16BE(sr, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - sr, 10);
  let offset = dir.length;
  const parts = [dir];
  tabs.forEach((t, i) => {
    const pad = (4 - (t.data.length % 4)) % 4, p = 12 + i * 16;
    dir.write(t.tag, p, 'latin1');
    dir.writeUInt32BE(checksum(t.data), p + 4);
    dir.writeUInt32BE(offset, p + 8);
    dir.writeUInt32BE(t.data.length, p + 12);
    parts.push(t.data, Buffer.alloc(pad));
    offset += t.data.length + pad;
  });
  return { sfnt: Buffer.concat(parts), tables: Object.fromEntries(tabs.map((t) => [t.tag, t.data])) };
}

function parseCmap(c) {
  const n = c.readUInt16BE(2);
  let best = null, score = -1;
  for (let i = 0; i < n; i++) {
    const pid = c.readUInt16BE(4 + i * 8), eid = c.readUInt16BE(6 + i * 8), off = c.readUInt32BE(8 + i * 8);
    const fmt = c.readUInt16BE(off);
    const s = pid === 3 && eid === 10 && fmt === 12 ? 4 : pid === 0 && fmt === 12 ? 3 : pid === 3 && eid === 1 && fmt === 4 ? 2 : pid === 0 && fmt === 4 ? 1 : 0;
    if (s > score) { score = s; best = { off, fmt }; }
  }
  if (!best || score === 0) throw new Error('No usable cmap');
  const map = new Map();
  const { off, fmt } = best;
  if (fmt === 4) {
    const sc = c.readUInt16BE(off + 6) / 2;
    const endO = off + 14, startO = endO + sc * 2 + 2, deltaO = startO + sc * 2, rangeO = deltaO + sc * 2;
    for (let s = 0; s < sc; s++) {
      const end = c.readUInt16BE(endO + s * 2), start = c.readUInt16BE(startO + s * 2);
      const delta = c.readUInt16BE(deltaO + s * 2), ro = c.readUInt16BE(rangeO + s * 2);
      for (let cp = start; cp <= end && cp < 0xffff; cp++) {
        let gid;
        if (ro === 0) gid = (cp + delta) & 0xffff;
        else { const g = c.readUInt16BE(rangeO + s * 2 + ro + (cp - start) * 2); gid = g ? (g + delta) & 0xffff : 0; }
        if (gid) map.set(cp, gid);
      }
    }
  } else {
    const ng = c.readUInt32BE(off + 12);
    for (let i = 0; i < ng; i++) {
      const o = off + 16 + i * 12;
      const s = c.readUInt32BE(o), e = c.readUInt32BE(o + 4), g = c.readUInt32BE(o + 8);
      for (let cp = s; cp <= e; cp++) map.set(cp, g + cp - s);
    }
  }
  return map;
}

export class TTFont {
  constructor(psName, file) {
    this.psName = psName;
    const { sfnt, tables: t } = woffToSfnt(readFileSync(file));
    this.sfnt = sfnt;
    this.upem = t.head.readUInt16BE(18);
    this.bbox = [36, 38, 40, 42].map((o) => Math.round((t.head.readInt16BE(o) * 1000) / this.upem));
    this.ascent = Math.round((t.hhea.readInt16BE(4) * 1000) / this.upem);
    this.descent = Math.round((t.hhea.readInt16BE(6) * 1000) / this.upem);
    this.nHM = t.hhea.readUInt16BE(34);
    this.hmtx = t.hmtx;
    this.cmap = parseCmap(t.cmap);
    this.capHeight = t['OS/2'] && t['OS/2'].length >= 90 && t['OS/2'].readUInt16BE(0) >= 2
      ? Math.round((t['OS/2'].readInt16BE(88) * 1000) / this.upem) : Math.round(this.ascent * 0.7);
    this.pdf = null; // per-document registration state, managed by PdfDoc
  }
  gid(cp) { return this.cmap.get(cp) || 0; }
  adv(gid) { return (this.hmtx.readUInt16BE(Math.min(gid, this.nHM - 1) * 4) * 1000) / this.upem; }
}

export class FontStack {
  constructor(fonts) { this.fonts = fonts; }
  pick(cp) { for (const f of this.fonts) if (f.gid(cp)) return f; return null; }
  has(cp) { return !!this.pick(cp); }
  runs(str) {
    const out = [];
    for (const ch of String(str).normalize('NFC')) {
      let cp = ch.codePointAt(0);
      let f = this.pick(cp);
      if (!f) { cp = 63; f = this.pick(63) || this.fonts[0]; }
      const g = [f.gid(cp), cp];
      const last = out[out.length - 1];
      if (last && last.font === f) last.g.push(g); else out.push({ font: f, g: [g] });
    }
    return out;
  }
  width(str, size, spacing = 0) {
    let w = 0, n = 0;
    for (const r of this.runs(str)) for (const [gid] of r.g) { w += (r.font.adv(gid) * size) / 1000; n++; }
    return w + spacing * n;
  }
}
