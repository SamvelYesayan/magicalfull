// Mobile navigation: "M" portal button + full-screen layer (markup lives in index.html, styles in mobile-menu.css).
// Desktop is untouched: the button/layer are display:none above 960px, and this module closes the layer if the viewport grows past it.
const mb = document.getElementById('mb'), mm = document.getElementById('mm');
if (mb && mm) {
  const header = document.querySelector('header'), root = document.documentElement;
  const links = [...mm.querySelectorAll('a[href^="#"]')];
  const items = [...mm.querySelectorAll('.mm-i')];
  const desk = matchMedia('(min-width:961px)');
  const RM = matchMedia('(prefers-reduced-motion:reduce)').matches;
  let isOpen = false, idleTimer = 0;

  // floating particles (few, small, slow)
  const dots = mm.querySelector('.mm-dots');
  if (dots && !RM) {
    const cols = ['#a78bfa', '#a78bfa', '#38bdf8', '#ffffff'];
    for (let i = 0; i < 14; i++) {
      const d = document.createElement('i'), s = (1.5 + Math.random() * 2).toFixed(1);
      d.style.cssText = `--x:${(Math.random() * 100).toFixed(1)}%;--s:${s}px;--t:${(9 + Math.random() * 9).toFixed(1)}s;--d:-${(Math.random() * 14).toFixed(1)}s;--pc:${cols[i % cols.length]}`;
      dots.appendChild(d);
    }
  }

  // which section is currently on screen (quiet highlight in the menu)
  // only in-page (#hash) rows take part; page links such as /pioneer-card are skipped
  const targets = links.filter(a => a.classList.contains('mm-i')).map(a => [a, document.querySelector(a.getAttribute('href'))]).filter(t => t[1]);
  function spy() {
    const y = innerHeight * 0.35; let cur = null;
    targets.forEach(([a, s]) => { if (s.getBoundingClientRect().top <= y) cur = a; });
    targets.forEach(([a]) => { a.classList.toggle('cur', a === cur); a === cur ? a.setAttribute('aria-current', 'true') : a.removeAttribute('aria-current'); });
  }
  function rail() { const n = mm.querySelector('.mm-nav'); n.style.setProperty('--rail', n.offsetHeight + 'px'); }
  const label = o => document.documentElement.lang === 'hy' ? (o ? 'Փակել' : 'Մենյու') : (o ? 'Close menu' : 'Menu');

  // Aim the reveal circle at the button centre. Origin is written with transitions off and committed, so the circle
  // grows from the real button centre instead of interpolating from the CSS default origin.
  let aimed = false, warmT = 0, byPointer = false;
  function aim() {
    const r = mb.getBoundingClientRect();
    mm.style.transition = 'none';
    mm.style.setProperty('--ox', (r.left + r.width / 2) + 'px');
    mm.style.setProperty('--oy', (r.top + r.height / 2) + 'px');
    void mm.offsetWidth;
    mm.style.transition = '';
    aimed = true;
  }
  // Press-down happens ~50-150ms before the click: do the measuring / forced layout there and let the compositor
  // paint the (still fully clipped, invisible) layer, so the click frame itself only starts the transitions.
  function warm() {
    byPointer = true;
    if (isOpen) return;
    aim(); spy(); rail();
    mm.classList.add('warm');
    clearTimeout(warmT); warmT = setTimeout(cool, 1500);
  }
  function cool() { clearTimeout(warmT); if (!isOpen) mm.classList.remove('warm'); }

  function setOpen(o, opts = {}) {
    if (o === isOpen) return;
    isOpen = o;
    if (o) {
      if (!aimed) { aim(); spy(); rail(); }   // keyboard / no press-down: same as before
      aimed = false;
    }
    // keep decorative animations running through the whole close, pause them only once the layer is gone
    clearTimeout(idleTimer);
    if (o) mm.classList.remove('idle'); else idleTimer = setTimeout(() => { if (!isOpen) mm.classList.add('idle'); }, 1100);
    mm.classList.remove('warm');
    mm.classList.toggle('open', o); mb.classList.toggle('open', o); header.classList.toggle('mo', o);
    root.classList.toggle('mm-lock', o);
    mb.setAttribute('aria-expanded', String(o)); mb.setAttribute('aria-label', label(o));
    mm.setAttribute('aria-hidden', String(!o));
    if (o) setTimeout(() => { if (isOpen) links[0].focus({ preventScroll: true, focusVisible: !byPointer }); }, 520);
    else if (opts.focus !== false) mb.focus({ preventScroll: true, focusVisible: !byPointer });
  }

  mb.addEventListener('pointerdown', warm, { passive: true });
  mb.addEventListener('pointercancel', cool);
  addEventListener('resize', () => { aimed = false; });
  mb.addEventListener('click', () => { setOpen(!isOpen); cool(); });
  mb.addEventListener('keydown', () => { byPointer = false; });
  addEventListener('keydown', e => { if (e.key === 'Escape') byPointer = false; }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen) setOpen(false); });
  desk.addEventListener('change', e => { if (e.matches) setOpen(false, { focus: false }); });

  // tapping a link: close, then glide to the real section (same smooth scroll the desktop nav uses)
  links.forEach(a => a.addEventListener('click', e => {
    const t = document.querySelector(a.getAttribute('href'));
    if (!t) return;
    e.preventDefault();
    setOpen(false, { focus: false });
    setTimeout(() => { t.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'start' }); history.replaceState(null, '', a.getAttribute('href')); }, 80);
  }));

  // returning to the page from the back/forward cache (e.g. after opening /pioneer-card) must not show a stale open layer
  addEventListener('pageshow', e => { if (e.persisted && isOpen) setOpen(false, { focus: false }); });

  // spotlight follows the finger / cursor; mouse hover lights a row (touch uses :active)
  items.forEach(a => {
    const move = e => { const r = a.getBoundingClientRect(); a.style.setProperty('--x', (e.clientX - r.left) + 'px'); a.style.setProperty('--y', (e.clientY - r.top) + 'px'); };
    a.addEventListener('pointermove', move); a.addEventListener('pointerdown', move);
    a.addEventListener('pointerenter', e => { if (e.pointerType === 'mouse') { move(e); a.classList.add('hot'); } });
    a.addEventListener('pointerleave', () => a.classList.remove('hot'));
  });
  if (/[?&]mmdiag/.test(location.search)) import('./menu-diag.js');
}
