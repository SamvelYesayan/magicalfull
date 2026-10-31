// Streaming PDF 1.7 writer. Objects are written as they are produced, so memory use stays
// flat no matter how many pages a document has. Fonts are embedded (TrueType, Identity-H).
import { deflateSync } from 'node:zlib';

export const bufferSink = () => {
  const chunks = [];
  return { write: (b) => { chunks.push(b); }, result: () => Buffer.concat(chunks) };
};
export const streamSink = (res) => ({
  write: (b) => (res.write(b) ? undefined : new Promise((ok) => res.once('drain', ok))),
});

const hex4 = (n) => n.toString(16).padStart(4, '0');
const num = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, ''));
const utf16hex = (s) => 'FEFF' + [...Buffer.from(s, 'utf16le')].reduce((a, _, i, b) => (i % 2 ? a : a + hex4((b[i + 1] << 8) | b[i])), '');

export class PdfDoc {
  // viewerPrefs: extra /ViewerPreferences entries, e.g. '/PrintScaling /None /Duplex /DuplexFlipLongEdge' (print dialog defaults)
  constructor(sink, { title = '', width, height, viewerPrefs = '' }) {
    Object.assign(this, { sink, title, width, height, viewerPrefs, pos: 0, offsets: [], nextId: 1, kids: [], fonts: [], shadings: new Map(), images: new Map(), gstates: new Map() });
    this.pagesId = this.reserve(); this.resId = this.reserve(); this.catId = this.reserve(); this.infoId = this.reserve();
  }
  reserve() { return this.nextId++; }
  async raw(b) { if (typeof b === 'string') b = Buffer.from(b, 'latin1'); this.pos += b.length; await this.sink.write(b); }
  async start() { await this.raw(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); }
  async obj(id, body) { this.offsets[id] = this.pos; await this.raw(`${id} 0 obj\n${body}\nendobj\n`); }
  async stream(id, dict, data, compress = true) {
    if (compress) { data = deflateSync(data); dict += ' /Filter /FlateDecode'; }
    this.offsets[id] = this.pos;
    await this.raw(`${id} 0 obj\n<< ${dict} /Length ${data.length} >>\nstream\n`);
    await this.raw(data);
    await this.raw('\nendstream\nendobj\n');
  }
  // ---- shared resources -------------------------------------------------
  async shading(key, dict) {
    if (!this.shadings.has(key)) { const id = this.reserve(); this.shadings.set(key, { id, name: `Sh${this.shadings.size + 1}` }); await this.obj(id, dict); }
    return this.shadings.get(key).name;
  }
  async gstate(key, dict) { // graphics state (e.g. a blend mode); dict is an ExtGState dictionary
    if (!this.gstates.has(key)) { const id = this.reserve(); this.gstates.set(key, { id, name: `GS${this.gstates.size + 1}` }); await this.obj(id, dict); }
    return this.gstates.get(key).name;
  }
  async image(key, { w, h, rgb, alpha }) {
    if (!this.images.has(key)) {
      const sm = this.reserve(), id = this.reserve();
      await this.stream(sm, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceGray /BitsPerComponent 8`, alpha);
      await this.stream(id, `/Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /SMask ${sm} 0 R`, rgb);
      this.images.set(key, { id, name: `Im${this.images.size + 1}` });
    }
    return this.images.get(key).name;
  }
  async fontName(font, gid, cp) {
    if (!font.pdf || font.pdf.doc !== this) {
      const ids = { ff: this.reserve(), type0: this.reserve(), cid: this.reserve(), desc: this.reserve(), tu: this.reserve() };
      font.pdf = { doc: this, ids, used: new Map(), name: `F${this.fonts.length + 1}` };
      this.fonts.push(font);
      await this.stream(ids.ff, `/Length1 ${font.sfnt.length}`, font.sfnt);
    }
    font.pdf.used.set(gid, cp);
    return font.pdf.name;
  }
  // ---- pages ------------------------------------------------------------
  async addPage(content) {
    const cid = this.reserve(), pid = this.reserve();
    await this.stream(cid, '', Buffer.from(content, 'latin1'));
    await this.obj(pid, `<< /Type /Page /Parent ${this.pagesId} 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources ${this.resId} 0 R /Contents ${cid} 0 R >>`);
    this.kids.push(pid);
  }
  async end() {
    const fontEntries = [];
    for (const f of this.fonts) {
      const { ids, used } = f.pdf;
      fontEntries.push(`/${f.pdf.name} ${ids.type0} 0 R`);
      const gids = [...used.keys()].sort((a, b) => a - b);
      const W = gids.map((g) => `${g} [${num(Math.round(f.adv(g)))}]`).join(' ');
      await this.obj(ids.type0, `<< /Type /Font /Subtype /Type0 /BaseFont /${f.psName} /Encoding /Identity-H /DescendantFonts [${ids.cid} 0 R] /ToUnicode ${ids.tu} 0 R >>`);
      await this.obj(ids.cid, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${f.psName} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${ids.desc} 0 R /CIDToGIDMap /Identity /DW 600 /W [${W}] >>`);
      await this.obj(ids.desc, `<< /Type /FontDescriptor /FontName /${f.psName} /Flags 32 /FontBBox [${f.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${f.ascent} /Descent ${f.descent} /CapHeight ${f.capHeight} /StemV 80 /FontFile2 ${ids.ff} 0 R >>`);
      let cm = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
      for (let i = 0; i < gids.length; i += 100) {
        const part = gids.slice(i, i + 100);
        cm += `${part.length} beginbfchar\n` + part.map((g) => {
          const cp = used.get(g);
          const u = cp > 0xffff ? hex4(0xd800 + ((cp - 0x10000) >> 10)) + hex4(0xdc00 + ((cp - 0x10000) & 0x3ff)) : hex4(cp);
          return `<${hex4(g)}> <${u}>`;
        }).join('\n') + '\nendbfchar\n';
      }
      cm += 'endcmap CMapName currentdict /CMap defineresource pop end end';
      await this.stream(ids.tu, '', Buffer.from(cm, 'latin1'));
      f.pdf = null;
    }
    const fontRes = fontEntries.length ? `/Font << ${fontEntries.join(' ')} >>` : '';
    const sh = this.shadings.size ? `/Shading << ${[...this.shadings.values()].map((s) => `/${s.name} ${s.id} 0 R`).join(' ')} >>` : '';
    const im = this.images.size ? `/XObject << ${[...this.images.values()].map((s) => `/${s.name} ${s.id} 0 R`).join(' ')} >>` : '';
    const gs = this.gstates.size ? `/ExtGState << ${[...this.gstates.values()].map((s) => `/${s.name} ${s.id} 0 R`).join(' ')} >>` : '';
    await this.obj(this.resId, `<< /ProcSet [/PDF /Text /ImageB /ImageC] ${fontRes} ${sh} ${im} ${gs} >>`);
    await this.obj(this.pagesId, `<< /Type /Pages /Kids [${this.kids.map((k) => k + ' 0 R').join(' ')}] /Count ${this.kids.length} >>`);
    await this.obj(this.catId, `<< /Type /Catalog /Pages ${this.pagesId} 0 R /Lang (hy) /ViewerPreferences << /DisplayDocTitle true${this.viewerPrefs ? ' ' + this.viewerPrefs : ''} >> >>`);
    const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
    const date = `D:${d.getUTCFullYear()}${p2(d.getUTCMonth() + 1)}${p2(d.getUTCDate())}${p2(d.getUTCHours())}${p2(d.getUTCMinutes())}${p2(d.getUTCSeconds())}Z`;
    await this.obj(this.infoId, `<< /Title <${utf16hex(this.title)}> /Producer (Magical invitations) /Creator (Magical) /CreationDate (${date}) >>`);
    const xref = this.pos, N = this.nextId;
    let x = `xref\n0 ${N}\n0000000000 65535 f \n`;
    for (let i = 1; i < N; i++) {
      if (this.offsets[i] === undefined) throw new Error('PDF object ' + i + ' was reserved but never written');
      x += `${String(this.offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    await this.raw(x + `trailer\n<< /Size ${N} /Root ${this.catId} 0 R /Info ${this.infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  }
}

// Per-page drawing surface in top-left coordinates (like the browser).
export class Canvas {
  constructor(doc) { this.doc = doc; this.ops = []; this.H = doc.height; this.fonts = new Map(); }
  y(v) { return num(this.H - v); }
  add(s) { this.ops.push(s); return this; }
  color(c, stroke) { return this.add(`${c.map((v) => num(v)).join(' ')} ${stroke ? 'RG' : 'rg'}`); }
  save() { return this.add('q'); }
  restore() { return this.add('Q'); }
  rectPath(x, y, w, h) { return this.add(`${num(x)} ${this.y(y + h)} ${num(w)} ${num(h)} re`); }
  rrPath(x, y, w, h, r) {
    const k = 0.5523 * r, X = (v) => num(v), Y = (v) => this.y(v);
    return this.add(`${X(x + r)} ${Y(y)} m ${X(x + w - r)} ${Y(y)} l ${X(x + w - r + k)} ${Y(y)} ${X(x + w)} ${Y(y + r - k)} ${X(x + w)} ${Y(y + r)} c ` +
      `${X(x + w)} ${Y(y + h - r)} l ${X(x + w)} ${Y(y + h - r + k)} ${X(x + w - r + k)} ${Y(y + h)} ${X(x + w - r)} ${Y(y + h)} c ` +
      `${X(x + r)} ${Y(y + h)} l ${X(x + r - k)} ${Y(y + h)} ${X(x)} ${Y(y + h - r + k)} ${X(x)} ${Y(y + h - r)} c ` +
      `${X(x)} ${Y(y + r)} l ${X(x)} ${Y(y + r - k)} ${X(x + r - k)} ${Y(y)} ${X(x + r)} ${Y(y)} c h`);
  }
  circlePath(cx, cy, r) {
    const k = 0.5523 * r, X = (v) => num(v), Y = (v) => this.y(v);
    return this.add(`${X(cx + r)} ${Y(cy)} m ${X(cx + r)} ${Y(cy - k)} ${X(cx + k)} ${Y(cy - r)} ${X(cx)} ${Y(cy - r)} c ${X(cx - k)} ${Y(cy - r)} ${X(cx - r)} ${Y(cy - k)} ${X(cx - r)} ${Y(cy)} c ` +
      `${X(cx - r)} ${Y(cy + k)} ${X(cx - k)} ${Y(cy + r)} ${X(cx)} ${Y(cy + r)} c ${X(cx + k)} ${Y(cy + r)} ${X(cx + r)} ${Y(cy + k)} ${X(cx + r)} ${Y(cy)} c h`);
  }
  // Every painting helper sets graphics state BEFORE building the path (PDF forbids state
  // operators between path construction and painting).
  fillRR(x, y, w, h, r, c) { this.color(c); this.rrPath(x, y, w, h, r); return this.add('f'); }
  fillRect(x, y, w, h, c) { this.color(c); this.rectPath(x, y, w, h); return this.add('f'); }
  fillCircle(cx, cy, r, c) { this.color(c); this.circlePath(cx, cy, r); return this.add('f'); }
  strokeRR(x, y, w, h, r, lw, c) { this.save().color(c, true).add(`${num(lw)} w`); this.rrPath(x, y, w, h, r); this.add('S'); return this.restore(); }
  clipRR(x, y, w, h, r) { this.save(); this.rrPath(x, y, w, h, r); return this.add('W n'); }
  clipRect(x, y, w, h) { this.save(); this.rectPath(x, y, w, h); return this.add('W n'); }
  shade(name) { return this.add(`/${name} sh`); }
  line(x1, y1, x2, y2, lw, c, dash) {
    this.save().color(c, true).add(`${num(lw)} w` + (dash ? ` [${dash.join(' ')}] 0 d` : ''));
    this.add(`${num(x1)} ${this.y(y1)} m ${num(x2)} ${this.y(y2)} l S`);
    return this.restore();
  }
  star(cx, cy, r, c) { // four-point sparkle
    const i = r * 0.28, p = [[0, -r], [i, -i], [r, 0], [i, i], [0, r], [-i, i], [-r, 0], [-i, -i]].map(([a, b]) => `${num(cx + a)} ${this.y(cy + b)}`);
    return this.color(c).add(`${p[0]} m ${p.slice(1).map((q) => q + ' l').join(' ')} h f`);
  }
  async drawImage(name, x, y, w, h) { return this.add(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${this.y(y + h)} cm /${name} Do Q`); }
  async text(stack, str, x, baseline, size, color, { align = 'left', spacing = 0 } = {}) {
    const total = stack.width(str, size, spacing);
    let cx = align === 'center' ? x - total / 2 : align === 'right' ? x - total : x;
    this.color(color);
    for (const r of stack.runs(str)) {
      let name;
      let hex = '';
      for (const [gid, cp] of r.g) { name = await this.doc.fontName(r.font, gid, cp); hex += hex4(gid); }
      this.add(`BT /${name} ${num(size)} Tf ${num(spacing)} Tc ${num(cx)} ${this.y(baseline)} Td <${hex}> Tj ET`);
      for (const [gid] of r.g) cx += (r.font.adv(gid) * size) / 1000 + spacing;
    }
  }
  toString() { return this.ops.join('\n'); }
}
