// Event announcement popup. Shown once per browser session; can be reopened via the floating
// button or by visiting /#event. Text lives in shared/event.js.
import { EVENT } from '../../shared/event.js';

const KEY = 'mg-announce-dismissed';
const ARROW = '<svg class="i"><use href="#arrow"/></svg>';
const get = () => { try { return sessionStorage.getItem(KEY) === '1'; } catch { return false; } };
const set = () => { try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode */ } };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const root = document.createElement('div');
root.className = 'ann';
root.setAttribute('role', 'dialog');
root.setAttribute('aria-modal', 'true');
root.setAttribute('aria-labelledby', 'ann-t');
root.setAttribute('aria-hidden', 'true');
root.inert = true;
root.innerHTML = `<div class="ann-card" tabindex="-1">
  <button class="ann-x" type="button" aria-label="Փակել"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
  <img class="ann-mk" src="/assets/magical-m.png" alt="" width="52" height="38">
  <span class="tag">MAGICAL</span>
  <h2 class="ann-t" id="ann-t">${esc(EVENT.nameUpper)}</h2>
  <p class="ann-lead">${esc(EVENT.announcement)}</p>
  <p class="ann-sub">${esc(EVENT.perks)}</p>
  <a class="btn p ann-cta" href="/invitation">${esc(EVENT.cta)} ${ARROW}</a>
</div>`;
const fab = document.createElement('button');
fab.type = 'button';
fab.className = 'ann-fab';
fab.setAttribute('aria-label', EVENT.cta);
fab.innerHTML = `<svg class="i"><use href="#cal"/></svg><span>${esc(EVENT.cta)}</span>`;
document.body.append(root, fab);

const card = root.querySelector('.ann-card');
const closeBtn = root.querySelector('.ann-x');
const cta = root.querySelector('.ann-cta');
let lastFocus = null;

function open() {
  if (root.classList.contains('open')) return;
  lastFocus = document.activeElement;
  root.inert = false;
  root.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('ann-lock');
  fab.classList.remove('show');
  requestAnimationFrame(() => { root.classList.add('open'); card.focus({ preventScroll: true }); });
}
function close() {
  if (!root.classList.contains('open')) return;
  set();
  root.classList.remove('open');
  root.setAttribute('aria-hidden', 'true');
  root.inert = true;
  document.documentElement.classList.remove('ann-lock');
  fab.classList.add('show');
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true });
}
closeBtn.addEventListener('click', close);
root.addEventListener('click', (e) => { if (e.target === root) close(); });
cta.addEventListener('click', set);
fab.addEventListener('click', open);
document.addEventListener('keydown', (e) => {
  if (!root.classList.contains('open')) return;
  if (e.key === 'Escape') return close();
  if (e.key === 'Tab') { // keep focus inside the dialog
    const f = [closeBtn, cta];
    const i = f.indexOf(document.activeElement);
    if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
  }
});
const wantsOpen = () => location.hash === '#event';
window.addEventListener('hashchange', () => { if (wantsOpen()) open(); });

if (wantsOpen()) setTimeout(open, 400);
else if (get()) fab.classList.add('show');
else setTimeout(open, 900); // let the hero entrance play first
