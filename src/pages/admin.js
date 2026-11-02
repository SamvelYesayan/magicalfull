import { viewPioneer } from './admin-pioneer.js';

const app = document.getElementById('app');
let csrf = '', me = '';
const state = { tab: 'msg', msg: { q: '', status: '', page: 1 }, stats: { messages: 0, newMessages: 0 } };
const fmt = new Intl.DateTimeFormat('hy-AM', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Yerevan' });
const when = (iso) => { try { return fmt.format(new Date(iso)); } catch { return iso || ''; } };

// h('div.cls', {attr}, children...) — text goes through textContent, never innerHTML
function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split('.');
  const el = document.createElement(t);
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf;
  const r = await fetch('/api/admin' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  // generated documents (e.g. the Pioneer print sheet) come back as a Blob kept only in memory
  if (r.ok && (r.headers.get('content-type') || '').startsWith('application/pdf'))
    return { blob: await r.blob(), headers: r.headers, filename: /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] || 'document.pdf' };
  let d = null; try { d = await r.json(); } catch { /* none */ }
  if (r.status === 401 && path !== '/login') { renderLogin('Սեսիան ավարտվել է, մուտք գործեք կրկին։'); throw new Error('auth'); }
  if (!r.ok) { const e = new Error(d?.error?.message || 'Սխալ'); e.fields = d?.error?.fields; e.code = d?.error?.code; e.status = r.status; throw e; }
  return d;
}

function renderLogin(note) {
  csrf = '';
  const err = h('div.err', { role: 'alert' });
  if (note) { err.textContent = note; err.classList.add('on'); }
  const u = h('input', { id: 'u', autocomplete: 'username', required: true, maxlength: 100 });
  const p = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true, maxlength: 200 });
  const go = h('button.btn.p', { type: 'submit' }, 'Մուտք');
  const form = h('form', { onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; err.classList.remove('on');
    try {
      const d = await api('/login', { method: 'POST', body: { username: u.value, password: p.value } });
      csrf = d.csrfToken; me = d.username; p.value = ''; boot();
    } catch (x) { err.textContent = x.status === 429 ? 'Չափազանց շատ փորձեր։ Փորձեք մի փոքր ուշ։' : x.message; err.classList.add('on'); }
    finally { go.disabled = false; }
  } },
  h('h1', {}, 'Ադմին վահանակ'), h('p.sub', {}, 'Մուտք գործեք՝ շարունակելու համար'),
  h('label', { for: 'u' }, 'Օգտանուն'), u, h('label', { for: 'p' }, 'Գաղտնաբառ'), p, err, go);
  app.replaceChildren(h('div.login', {}, h('div', {}, h('a.logo', { href: '/' }, h('img.mk', { src: '/assets/magical-m.png', alt: '', width: 33, height: 24 }), 'MAGICAL'), form)));
  u.focus();
}

function modal(title, content, { small } = {}) {
  const prev = document.activeElement;
  const close = () => { m.remove(); document.removeEventListener('keydown', esc); prev?.focus?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const m = h('div.modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === m) close(); } },
    h('div.mcard' + (small ? '.sm' : ''), {}, h('button.mx', { type: 'button', 'aria-label': 'Փակել', onclick: close }, '×'), h('h2', {}, title), content));
  document.addEventListener('keydown', esc);
  document.body.append(m);
  m.querySelector('.mx').focus();
  return close;
}

async function refreshStats() {
  state.stats = await api('/stats');
  try { state.stats.pioneer = await api('/pioneer/stats'); } catch (e) { if (e.message === 'auth') throw e; }
}

function renderShell() {
  const tabs = h('div.tabs', { role: 'tablist' },
    h('button.tab', { role: 'tab', 'aria-selected': state.tab === 'msg', onclick: () => { state.tab = 'msg'; boot(); } }, 'Հաղորդագրություններ', h('b', {}, state.stats.newMessages ? `${state.stats.newMessages} / ${state.stats.messages}` : state.stats.messages)),
    h('button.tab', { role: 'tab', 'aria-selected': state.tab === 'pc', onclick: () => { state.tab = 'pc'; boot(); } }, 'Pioneer Cards', h('b', {}, state.stats.pioneer?.pendingRedemptions ? `${state.stats.pioneer.pendingRedemptions} / ${state.stats.pioneer.cards}` : state.stats.pioneer?.cards ?? 0)));
  const content = h('div', { id: 'content' });
  app.replaceChildren(
    h('div.bar', {}, h('div.a-wrap', {}, h('a.logo', { href: '/' }, h('img.mk', { src: '/assets/magical-m.png', alt: '', width: 33, height: 24 }), 'MAGICAL'), h('span.sp'), h('span.who', {}, me),
      h('button.btn.sm', { type: 'button', onclick: passwordModal }, 'Գաղտնաբառ'), h('button.btn.sm', { type: 'button', onclick: logout }, 'Դուրս գալ'))),
    h('div.a-wrap', {}, tabs, content));
  return content;
}

async function logout() { try { await api('/logout', { method: 'POST' }); } catch { /* ignore */ } renderLogin(); }

function passwordModal() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', maxlength: 200 }), nw = h('input', { type: 'password', autocomplete: 'new-password', maxlength: 200 });
  const note = h('p.msg'); const go = h('button.btn.p', { type: 'submit' }, 'Փոխել');
  const form = h('form', { style: 'padding:0;border:0;background:none', onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; note.className = 'msg'; note.textContent = '';
    try { await api('/password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nw.value } }); note.textContent = 'Գաղտնաբառը փոխվել է։'; cur.value = nw.value = ''; }
    catch (x) { note.className = 'msg err'; note.textContent = Object.values(x.fields || {})[0] || x.message; }
    finally { go.disabled = false; }
  } }, h('label', {}, 'Ընթացիկ գաղտնաբառ'), cur, h('label', {}, 'Նոր գաղտնաբառ (առնվազն 10 նիշ)'), nw, note, go);
  modal('Գաղտնաբառի փոփոխություն', form, { small: true });
}

function pager(box, total, pageSize, page, set) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return h('div.pager', {}, h('button.btn.sm', { disabled: page <= 1, onclick: () => set(page - 1) }, '← Նախորդ'), h('span', {}, `${page} / ${pages}`), h('button.btn.sm', { disabled: page >= pages, onclick: () => set(page + 1) }, 'Հաջորդ →'));
}
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const STATUS = { new: 'Նոր', read: 'Կարդացված', processed: 'Մշակված' };
async function viewMessages(box) {
  const s = state.msg;
  const list = h('div'), count = h('span.count');
  const search = h('input', { type: 'search', placeholder: 'Որոնում հաղորդագրություններում', 'aria-label': 'Որոնում', value: s.q, maxlength: 100, oninput: debounce((e) => { s.q = e.target.value; s.page = 1; load(); }) });
  const sel = h('select', { 'aria-label': 'Կարգավիճակ', onchange: (e) => { s.status = e.target.value; s.page = 1; load(); } }, h('option', { value: '' }, 'Բոլորը'), Object.entries(STATUS).map(([k, v]) => h('option', { value: k, selected: s.status === k }, v)));
  box.append(h('div.tools', {}, search, sel, count), list);
  async function load() {
    try {
      const d = await api('/messages?' + new URLSearchParams({ q: s.q, status: s.status, page: s.page, pageSize: 20 }));
      s.page = d.page; count.textContent = `Ընդամենը՝ ${d.total}`;
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, 'Հաղորդագրություններ չեն գտնվել։')));
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Ամսաթիվ'), h('th', {}, 'Անուն'), h('th', {}, 'Էլ. փոստ'), h('th', {}, 'Հեռախոս'), h('th', {}, 'Ծառայություն'), h('th', {}, 'Հաղորդագրություն'), h('th', {}, 'Կարգավիճակ'))),
        h('tbody', {}, d.items.map((m) => h('tr.clk' + (m.status === 'new' ? '.unread' : ''), { tabindex: 0, onclick: () => openMessage(m, load), onkeydown: (e) => { if (e.key === 'Enter') openMessage(m, load); } },
          h('td', {}, when(m.createdAt)), h('td', {}, m.name), h('td', {}, m.email), h('td', {}, m.phone || '—'), h('td', {}, m.service || '—'),
          h('td', { style: 'max-width:280px;overflow:hidden;text-overflow:ellipsis' }, m.message || '—'), h('td', {}, h('span.st.' + m.status, {}, STATUS[m.status]))))))),
      pager(list, d.total, d.pageSize, d.page, (p) => { s.page = p; load(); }));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(h('div.empty', {}, e.message)); }
  }
  await load();
}

async function setStatus(m, status) { return (await api(`/messages/${m.id}`, { method: 'PATCH', body: { status } })).message; }
async function openMessage(m, reload) {
  if (m.status === 'new') { try { m = await setStatus(m, 'read'); await refreshStats(); reload(); } catch { /* keep going */ } }
  const note = h('p.msg');
  const btn = (label, status) => h('button.btn.sm' + (status === 'processed' ? '.p' : ''), { type: 'button', onclick: async () => { try { m = await setStatus(m, status); note.className = 'msg'; note.textContent = `Կարգավիճակ՝ ${STATUS[m.status]}`; await refreshStats(); reload(); } catch (e) { note.className = 'msg err'; note.textContent = e.message; } } }, label);
  modal(`Հաղորդագրություն՝ ${m.name}`, h('div', {},
    h('dl.kv', {}, h('dt', {}, 'Ամսաթիվ'), h('dd', {}, when(m.createdAt)), h('dt', {}, 'Անուն'), h('dd', {}, m.name), h('dt', {}, 'Էլ. փոստ'), h('dd', {}, h('a', { href: 'mailto:' + m.email, style: 'color:var(--pri2)' }, m.email)),
      h('dt', {}, 'Հեռախոս'), h('dd', {}, m.phone || '—'), h('dt', {}, 'Ծառայություն'), h('dd', {}, m.service || '—')),
    h('div.body', {}, m.message || '(դատարկ)'), h('div.macts', {}, btn('Նշել որպես կարդացված', 'read'), btn('Նշել որպես մշակված', 'processed'), btn('Նշել որպես նոր', 'new')), note));
}

async function boot() {
  try {
    if (!csrf) { const d = await api('/me'); csrf = d.csrfToken; me = d.username; }
    await refreshStats();
    const box = renderShell();
    await (state.tab === 'pc' ? viewPioneer(box, { h, api, modal, pager, debounce, when }) : viewMessages(box));
  } catch (e) { if (e.message === 'auth') return; renderLogin(); }
}

fetch('/api/admin/me', { credentials: 'same-origin' }).then(async (r) => {
  if (r.ok) { const d = await r.json(); csrf = d.csrfToken; me = d.username; boot(); } else renderLogin();
}).catch(() => renderLogin('Սերվերի հետ կապ չկա։'));
