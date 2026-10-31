import { EVENT } from '../../shared/event.js';
import { validateRegistration } from '../../shared/validation.js';
import { ticketHtml } from '../modules/ticket-view.js';

const $ = (id) => document.getElementById(id);
const form = $('reg'), btn = $('go'), banner = $('banner');
const FIELDS = { firstName: 'fn', lastName: 'ln', age: 'ag', phone: 'ph' };
$('ev-line').textContent = `${EVENT.dateText}, ${EVENT.time} · ${EVENT.location}`;

const MSG = {
  net: 'Չհաջողվեց կապ հաստատել սերվերի հետ։ Ձեր տվյալները պահպանված են այս էջում, փորձեք կրկին։',
  server: 'Սերվերի սխալ։ Գրանցումը չի կատարվել, խնդրում ենք փորձել կրկին։',
  rate: 'Չափազանց շատ փորձեր։ Խնդրում ենք փորձել մի փոքր ուշ։',
  gone: 'Հրավիրատոմսը չի գտնվել։ Լրացրեք ձևը՝ նորը ստանալու համար։',
};
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '').padEnd(12, 'x');
let key = newKey(), busy = false;

const showErr = (field, msg) => {
  const el = $('e-' + field), input = $(FIELDS[field]);
  el.textContent = msg || ''; el.classList.toggle('on', !!msg);
  if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
};
const values = () => ({ firstName: $('fn').value, lastName: $('ln').value, age: $('ag').value, phone: $('ph').value });
const banner_ = (t) => { banner.textContent = t || ''; banner.classList.toggle('on', !!t); };
for (const [f, id] of Object.entries(FIELDS)) $(id).addEventListener('blur', () => { if ($(id).value.trim() || $(id).hasAttribute('aria-invalid')) showErr(f, validateRegistration(values()).errors[f]); });
for (const id of Object.values(FIELDS)) $(id).addEventListener('input', () => { if ($(id).hasAttribute('aria-invalid')) showErr(Object.keys(FIELDS).find((k) => FIELDS[k] === id), validateRegistration(values()).errors[Object.keys(FIELDS).find((k) => FIELDS[k] === id)]); });

function showTicket(inv, token) {
  $('ticket').innerHTML = ticketHtml(inv);
  $('dl').href = `/api/invitations/${encodeURIComponent(token)}/pdf`;
  $('dl').setAttribute('download', `magical-invitation-${inv.number}.pdf`);
  $('view-form').hidden = true; $('view-load').hidden = true; $('view-done').hidden = false;
  history.replaceState(null, '', '#t=' + token);
  window.scrollTo({ top: 0 });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  banner_('');
  const v = validateRegistration(values());
  for (const f of Object.keys(FIELDS)) showErr(f, v.errors[f]);
  if (!v.ok) { $(FIELDS[Object.keys(v.errors)[0]]).focus(); return; }
  busy = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
  try {
    const r = await fetch('/api/registrations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(values()) });
    let d = null; try { d = await r.json(); } catch { /* non-JSON */ }
    if ((r.status === 201 || r.status === 200) && d && d.invitation && d.invitation.token) return showTicket(d.invitation, d.invitation.token);
    if (r.status === 422 && d && d.error && d.error.fields) {
      for (const f of Object.keys(FIELDS)) showErr(f, d.error.fields[f]);
      $(FIELDS[Object.keys(d.error.fields)[0]] || 'fn').focus();
    } else if (r.status === 409 && d) banner_(d.error.message);
    else banner_(r.status === 429 ? MSG.rate : MSG.server);
  } catch { banner_(MSG.net); }
  finally { busy = false; btn.disabled = false; btn.removeAttribute('aria-busy'); }
});

// Returning visitors: the secret link (#t=...) reopens their own invitation.
const m = /^#t=([A-Za-z0-9_-]{20,64})$/.exec(location.hash);
if (m) {
  $('view-form').hidden = true; $('view-load').hidden = false;
  fetch(`/api/invitations/${m[1]}`).then(async (r) => {
    const d = r.ok ? await r.json() : null;
    if (d && d.invitation) return showTicket(d.invitation, m[1]);
    history.replaceState(null, '', location.pathname);
    $('view-load').hidden = true; $('view-form').hidden = false; banner_(MSG.gone);
  }).catch(() => { $('view-load').hidden = true; $('view-form').hidden = false; banner_(MSG.net); });
}
