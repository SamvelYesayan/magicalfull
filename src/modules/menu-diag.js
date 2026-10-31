// On-device diagnostics for the mobile menu. Loaded ONLY when the URL contains ?mmdiag (separate chunk, zero cost otherwise).
// Open  https://<site>/?mmdiag  on the real phone, tap the menu button a few times, press "Copy report".
// The chips switch single suspects off (temporary CSS injected here; production CSS is untouched) so each can be A/B-tested live.
const mb = document.getElementById('mb'), mm = document.getElementById('mm'), root = document.documentElement;
const vv = window.visualViewport;
const SUSPECTS = {
  'no-mm-backdrop': '.mm{-webkit-backdrop-filter:none!important;backdrop-filter:none!important}',
  'no-header-fx': 'header,header.mo{transition:none!important}',
  'no-glow-blur': '.mm-glow{filter:none!important}',
  'no-item-blur': '.mm-i,.mm-foot{filter:none!important;transition-property:opacity,transform!important}',
  'no-wm-shadow': '.mm-wm{filter:none!important}',
  'keep-idle-paused': '.mm *{animation-play-state:paused!important}',
  // This is now the PRODUCTION default (chip kept so it can still be compared): no backdrop-filter, and the base colour made fully opaque so the page behind cannot ghost through
  'FIX-opaque-base': '.mm{-webkit-backdrop-filter:none!important;backdrop-filter:none!important;background:radial-gradient(120% 65% at 100% 0%,rgba(79,70,229,.26),transparent 62%),radial-gradient(100% 60% at 0% 100%,rgba(139,92,246,.24),transparent 60%),rgb(4,4,7)!important}',
  // restores the pre-fix production look (for comparison only; this is the version that jitters on Samsung)
  'OLD-backdrop': '.mm{background:radial-gradient(120% 65% at 100% 0%,rgba(79,70,229,.26),transparent 62%),radial-gradient(100% 60% at 0% 100%,rgba(139,92,246,.24),transparent 60%),rgba(4,4,7,.965)!important;-webkit-backdrop-filter:blur(18px)!important;backdrop-filter:blur(18px)!important}',
  'no-warm': '.mm.warm{visibility:hidden!important}',
};
const style = document.createElement('style'); document.head.appendChild(style);
const on = new Set(); const runs = [];
const css = () => { style.textContent = '@media(max-width:960px){' + [...on].map(k => SUSPECTS[k]).join('') + '}'; };

const vpState = () => ({ iw: innerWidth, ih: innerHeight, cw: root.clientWidth, ch: root.clientHeight,
  vw: vv && +vv.width.toFixed(1), vh: vv && +vv.height.toFixed(1), vt: vv && +vv.offsetTop.toFixed(1), vs: vv && +vv.scale.toFixed(3), sy: Math.round(scrollY) });
const sig = s => JSON.stringify(s);

let rec = null;
function start(kind) {
  if (rec) return;
  const t0 = performance.now();
  rec = { kind, t0, tc: 0, frames: [], ev: [], vp0: vpState(), rects: [], flags: [...on], lo: [] };
  let last = t0, prevSig = sig(rec.vp0);
  const tick = ts => {
    if (!rec) return;
    rec.frames.push([+(ts - t0).toFixed(1), +(ts - last).toFixed(1)]); last = ts;
    const s = sig(vpState()); if (s !== prevSig) { rec.ev.push([+(ts - t0).toFixed(0), 'viewport', s]); prevSig = s; }
    if (ts - t0 < 2200 && (!rec.tc || ts - rec.tc < 1300)) requestAnimationFrame(tick); else finish();
  };
  requestAnimationFrame(tick);
}
const lis = (t, n) => addEventListener(t, () => rec && rec.ev.push([+(performance.now() - rec.t0).toFixed(0), n]), true);
['resize', 'orientationchange', 'scroll'].forEach(t => lis(t, t));
vv && ['resize', 'scroll'].forEach(t => vv.addEventListener(t, () => rec && rec.ev.push([+(performance.now() - rec.t0).toFixed(0), 'vv-' + t])));
try { new PerformanceObserver(l => rec && l.getEntries().forEach(e => rec.lo.push([+(e.startTime - rec.t0).toFixed(0), e.entryType, +e.duration.toFixed(0), e.renderStart ? +(e.renderStart - e.startTime).toFixed(0) : 0]))).observe({ type: 'long-animation-frame', buffered: false }); } catch (e) {}
try { new PerformanceObserver(l => rec && l.getEntries().forEach(e => rec.lo.push([+(e.startTime - rec.t0).toFixed(0), 'layout-shift', +e.value.toFixed(4), 0]))).observe({ type: 'layout-shift', buffered: false }); } catch (e) {}

const R = el => { const r = el.getBoundingClientRect(); return [+r.left.toFixed(1), +r.top.toFixed(1), +r.width.toFixed(1), +r.height.toFixed(1)]; };
function finish() {
  const r = rec; rec = null;
  const post = r.frames.filter(f => f[0] >= (r.tc || 0) - r.t0 + 0).map(f => f[1]);
  const after = r.frames.filter(f => f[0] + r.t0 >= r.tc).map(f => f[1]);
  const sorted = [...after].sort((a, b) => a - b), med = sorted[sorted.length >> 1] || 0;
  const out = { n: runs.length + 1, kind: r.kind, flags: r.flags.join(',') || 'none', frames: after.length, refreshMs: +med.toFixed(1),
    maxMs: Math.max(0, ...after), over1_5x: after.filter(d => d > med * 1.5).length, over25ms: after.filter(d => d > 25).length,
    first8: after.slice(0, 8), rects: r.rects, vp0: r.vp0, vp1: vpState(), events: r.ev, longFrames: r.lo };
  runs.push(out); render();
}
mb.addEventListener('pointerdown', () => start(mm.classList.contains('open') ? 'close' : 'open'), true);
mb.addEventListener('click', () => {
  if (!rec) start('kbd');
  rec.tc = performance.now(); rec.rects.push(['click', R(mb), R(mm)]);
  [120, 500, 1100].forEach(d => setTimeout(() => rec && rec.rects.push([d, R(mb), R(mm)]), d));
}, true);

// panel
const box = document.createElement('div');
box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;max-height:42vh;overflow:auto;background:rgba(0,0,0,.92);color:#9f9;font:11px/1.35 ui-monospace,monospace;padding:6px 8px;border-top:1px solid #4a4';
const chips = document.createElement('div'); chips.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px';
const pre = document.createElement('pre'); pre.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all';
Object.keys(SUSPECTS).forEach(k => { const b = document.createElement('button'); b.textContent = k; b.type = 'button';
  const paint = () => b.style.cssText = 'font:11px monospace;padding:3px 6px;border:1px solid #4a4;border-radius:4px;color:' + (on.has(k) ? '#000' : '#9f9') + ';background:' + (on.has(k) ? '#9f9' : 'transparent');
  paint(); b.onclick = () => { on.has(k) ? on.delete(k) : on.add(k); paint(); css(); }; chips.appendChild(b); });
const cp = document.createElement('button'); cp.textContent = 'COPY REPORT'; cp.type = 'button'; cp.style.cssText = 'font:11px monospace;padding:3px 6px;border:1px solid #fa4;border-radius:4px;color:#fa4;background:transparent';
cp.onclick = () => { const t = JSON.stringify({ ua: navigator.userAgent, dpr: devicePixelRatio, screen: [screen.width, screen.height], runs }, null, 1);
  (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).then(() => cp.textContent = 'COPIED', () => { pre.textContent = t; cp.textContent = 'select text below'; }); };
chips.appendChild(cp); box.append(chips, pre); document.body.appendChild(box);
function render() {
  pre.textContent = runs.slice(-6).map(o => `#${o.n} ${o.kind} [${o.flags}] frames=${o.frames} refresh≈${o.refreshMs}ms MAX=${o.maxMs}ms >1.5x:${o.over1_5x} >25ms:${o.over25ms}\n   first8=${o.first8.join(',')}\n   viewport events: ${o.events.filter(e => e[1] !== 'scroll').map(e => e.join(':')).join(' | ') || 'none'}\n   long/shift: ${o.longFrames.map(l => l.join(':')).join(' | ') || 'none'}`).join('\n');
}
pre.textContent = 'mmdiag ready — tap the menu button (open + close), try the chips one at a time, then COPY REPORT.';
