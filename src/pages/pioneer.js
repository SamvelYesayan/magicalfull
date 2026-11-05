// Public Pioneer Card pages: /pioneer-card (about), /pioneer-card/login, /pioneer-card/account.
// One HTML entry (pioneer.html) with a tiny router. Balances, eligibility and every rule are decided
// by the server; this file only renders what the API returns. Text goes through textContent.
import { cardHtml, fmtCardNo, icon } from '../modules/pioneer-card-view.js';
import { normalizeCardNo, normalizeCvv, parsePoints, TX_LABELS, PIONEER_MSG, GIFT_PHONES, GIFT_STATUS } from '../../shared/pioneer.js';

const view = document.getElementById('view'), hdr = document.getElementById('hdr');
const ROUTES = { '/pioneer-card': renderAbout, '/pioneer-card/login': renderLogin, '/pioneer-card/account': renderAccount };
// Armenian month names spelled out: many browsers ship no hy-AM locale data and fall back to another language.
const MONTHS = ['հունվարի', 'փետրվարի', 'մարտի', 'ապրիլի', 'մայիսի', 'հունիսի', 'հուլիսի', 'օգոստոսի', 'սեպտեմբերի', 'հոկտեմբերի', 'նոյեմբերի', 'դեկտեմբերի'];
const parts = new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Yerevan' });
const ymd = (d) => Object.fromEntries(parts.formatToParts(new Date(d)).map((x) => [x.type, x.value]));
const fmtDay = { format: (d) => { const p = ymd(d); return `${p.day} ${MONTHS[p.month - 1]} ${p.year} թ.`; } };
const when = (iso) => { try { const p = ymd(iso); return `${p.day} ${MONTHS[p.month - 1]} ${p.year}, ${p.hour}:${p.minute}`; } catch { return iso || ''; } };
const num = (n) => Number(n || 0).toLocaleString('en-US');
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '');
let csrf = '';

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
const svg = (k, cls) => { const s = h('span', { style: 'display:contents' }); s.innerHTML = icon(k, cls); return s; }; // static markup only
const cardEl = (card, cls = '') => { const d = h('div' + cls); d.innerHTML = cardHtml(card); return d; };

class ApiError extends Error {}
async function api(path, { method = 'GET', body, key } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
  if (key) headers['Idempotency-Key'] = key;
  let r;
  try { r = await fetch('/api/pioneer' + path, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { throw Object.assign(new ApiError('Չհաջողվեց կապ հաստատել սերվերի հետ։ Ստուգեք ինտերնետը և փորձեք կրկին։'), { status: 0 }); }
  let d = null; try { d = await r.json(); } catch { /* none */ }
  if (!r.ok) throw Object.assign(new ApiError(d?.error?.message || 'Սխալ։ Փորձեք կրկին։'), { status: r.status, code: d?.error?.code, fields: d?.error?.fields, retryAfter: Number(r.headers.get('retry-after')) || 0 });
  return d;
}

function go(path, { replace } = {}) {
  history[replace ? 'replaceState' : 'pushState'](null, '', path);
  route();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-nav]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
  e.preventDefault(); go(a.getAttribute('href'));
});
window.addEventListener('popstate', route);
function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/pioneer-card';
  (ROUTES[path] || renderAbout)();
  window.scrollTo({ top: 0 });
}
const loading = () => view.replaceChildren(h('div.loading', {}, h('span.spin', { 'aria-label': 'Բեռնվում է' })));
function toast(text) {
  const t = h('div.toast', { role: 'status' }, text);
  document.body.append(t); setTimeout(() => t.remove(), 3200);
}
function setHeader(signedIn) {
  hdr.replaceChildren(h('a.btn', { href: '/' }, 'Գլխավոր էջ'),
    signedIn ? h('button.btn', { type: 'button', onclick: logout }, 'Դուրս գալ') : h('a.btn.p', { href: '/pioneer-card/login', 'data-nav': '' }, 'Մուտք'));
}
async function logout() {
  try { await api('/logout', { method: 'POST' }); } catch { /* session may already be gone */ }
  csrf = ''; go('/pioneer-card/login', { replace: true }); toast('Դուք դուրս եկաք։');
}

// ---------- /pioneer-card ----------------------------------------------------------------
function renderAbout() {
  document.title = 'Magical Pioneer Card';
  setHeader(false);
  const feat = (ic, t, p) => h('div.pc-feat', {}, h('div.ic', {}, svg(ic)), h('h3', {}, t), h('p', {}, p));
  const acct = h('a.btn', { href: '/pioneer-card/account', 'data-nav': '', style: 'display:none' }, 'Իմ հաշիվը');
  view.replaceChildren(
    h('section.pc-hero', { style: 'padding:0' },
      h('div', {}, h('div.tag-w', {}, h('span.tag', {}, 'MAGICAL PIONEER COMMUNITY')),
        h('h1', {}, 'Ձեր Pioneer Card-ը՝ Magical-ի աշխարհ մուտքի բանալին'),
        h('p.lead', {}, 'Pioneer Card-ը Magical համայնքի անդամակցության քարտ է։ Կուտակեք Pioneer միավորներ, փոխանցեք դրանք ընկերներին և օգտագործեք դասընթացների զեղչերի ու պարգևների համար։'),
        h('div.cta', {}, h('a.btn.p', { href: '/pioneer-card/login', 'data-nav': '' }, 'Մուտք գործել քարտով ', svg('arrow')), acct)),
      h('div.pc-float', {}, cardEl({ number: '00000000' }))),
    h('div.pc-feats', {},
      feat('star', 'Մեկնարկային միավորներ', 'Յուրաքանչյուր նոր քարտ ստանում է մեկնարկային Pioneer միավորներ, որոնք տեսանելի են ձեր անձնական էջում։'),
      feat('gift', 'Զեղչեր և պարգևներ', 'Օգտագործեք միավորները Magical-ի դասընթացների զեղչերի և պարգևների համար, երբ դրանք հասանելի են։'),
      feat('rocket', 'Միավորների փոխանցում', 'Փոխանցեք միավորներ մեկ այլ Pioneer անդամի՝ ընդամենը նրա 8 նիշանոց քարտի համարով։')),
    h('p.pc-note', {}, 'Pioneer Card-ը անդամակցության և լոյալության քարտ է, այն վճարային քարտ չէ և չի օգտագործվում վճարումների համար։ Քարտերը տրամադրում է Magical-ը։'));
  // Offer the account link if a session already exists (no redirect, no flicker for visitors).
  api('/me').then((d) => { csrf = d.csrfToken; acct.style.display = ''; setHeader(true); }).catch(() => {});
}

// ---------- /pioneer-card/login ------------------------------------------------------------
function renderLogin(note) {
  document.title = 'Մուտք — Magical Pioneer Card';
  setHeader(false);
  const errEl = (id) => h('div.err', { id, role: 'alert' });
  const no = h('input.code', { id: 'cn', inputmode: 'numeric', autocomplete: 'off', placeholder: '0000 0000', maxlength: 9, required: true, 'aria-describedby': 'e-cn', spellcheck: 'false' });
  const cvv = h('input.code', { id: 'cv', type: 'password', inputmode: 'numeric', autocomplete: 'off', placeholder: '•••', maxlength: 3, required: true, 'aria-describedby': 'e-cv' });
  const eNo = errEl('e-cn'), eCvv = errEl('e-cv');
  const banner = h('div.banner', { role: 'alert', hidden: !note }, note || '');
  const btn = h('button.btn.p', { type: 'submit' }, 'Մուտք ', svg('arrow'));
  const preview = cardEl({ number: '' }, '.mini');
  const setErr = (el, input, msg) => { el.textContent = msg || ''; el.classList.toggle('on', !!msg); if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); };
  const paint = () => { preview.querySelector('.pc-no').textContent = (no.value.replace(/\D/g, '') + '••••••••').slice(0, 8).replace(/^(.{4})/, '$1 '); };
  no.addEventListener('input', () => {
    const d = no.value.replace(/\D/g, '').slice(0, 8);
    no.value = d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d;
    if (d.length === 8 && document.activeElement === no) cvv.focus();
    if (no.hasAttribute('aria-invalid')) setErr(eNo, no, normalizeCardNo(d) ? '' : PIONEER_MSG.cardNumber);
    paint();
  });
  cvv.addEventListener('input', () => { cvv.value = cvv.value.replace(/\D/g, '').slice(0, 3); if (cvv.hasAttribute('aria-invalid')) setErr(eCvv, cvv, normalizeCvv(cvv.value) ? '' : PIONEER_MSG.cvv); });
  let busy = false;
  const form = h('form', { novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); if (busy) return;
    banner.hidden = true;
    const n = normalizeCardNo(no.value), c = normalizeCvv(cvv.value);
    setErr(eNo, no, n ? '' : PIONEER_MSG.cardNumber); setErr(eCvv, cvv, c ? '' : PIONEER_MSG.cvv);
    if (!n) return no.focus(); if (!c) return cvv.focus();
    busy = true; btn.disabled = true; btn.setAttribute('aria-busy', 'true');
    try {
      const d = await api('/login', { method: 'POST', body: { cardNumber: n, cvv: c } });
      csrf = d.csrfToken; cvv.value = '';
      go('/pioneer-card/account', { replace: true });
    } catch (x) {
      cvv.value = '';
      let msg = x.message;
      if (x.status === 401 && x.fields?.attemptsBeforeLock != null && x.fields.attemptsBeforeLock <= 2)
        msg += x.fields.attemptsBeforeLock ? ` Անվտանգության նկատառումներով ևս ${x.fields.attemptsBeforeLock} սխալ փորձից հետո մուտքը ժամանակավորապես կարգելափակվի։` : ' Մուտքը ժամանակավորապես արգելափակված է։';
      if (x.status === 429 && x.retryAfter) msg += ` Կրկին փորձեք ${x.retryAfter < 90 ? `${x.retryAfter} վայրկյանից` : x.retryAfter < 5400 ? `${Math.ceil(x.retryAfter / 60)} րոպեից` : `${Math.ceil(x.retryAfter / 3600)} ժամից`}։`;
      if (x.status === 422 && x.fields) { setErr(eNo, no, x.fields.cardNumber); setErr(eCvv, cvv, x.fields.cvv); }
      else { banner.textContent = msg; banner.hidden = false; }
      cvv.focus();
    } finally { busy = false; btn.disabled = false; btn.removeAttribute('aria-busy'); }
  } },
  h('div.row', {}, h('div', {}, h('label', { for: 'cn' }, 'Քարտի համար'), no, eNo), h('div', {}, h('label', { for: 'cv' }, 'CVV կոդ'), cvv, eCvv)),
  banner, btn,
  h('p.hint', {}, 'Քարտի համարը տպված է ձեր Pioneer Card-ի վրա։ 3 նիշանոց CVV կոդը տրամադրվում է առանձին և քարտի վրա չի նշվում։ Երբեք մի կիսվեք ձեր CVV-ով։ Եթե կորցրել եք այն, դիմեք Magical-ին։'));
  view.replaceChildren(h('div.pc-login', {}, preview, h('h1', {}, 'Մուտք Pioneer Card-ով'), h('p.pc-sub.muted', {}, 'Մուտքագրեք ձեր քարտի համարը և CVV կոդը'), form));
  paint();
  no.focus();
}

// ---------- /pioneer-card/account ------------------------------------------------------------
const acc = { tab: 'overview', me: null, rewards: null, txPage: 1 };
async function renderAccount() {
  document.title = 'Իմ հաշիվը — Magical Pioneer Card';
  loading();
  try {
    const [me, rewards] = await Promise.all([api('/me'), api('/rewards')]);
    csrf = me.csrfToken; acc.me = me; acc.rewards = rewards.items;
  } catch (x) {
    if (x.status === 401) { if (acc.me) return sessionLost(x); return go('/pioneer-card/login', { replace: true }); } // first visit while signed out: no "expired" notice
    return view.replaceChildren(h('div.empty-p', {}, h('b', {}, 'Չհաջողվեց բեռնել հաշիվը'), x.message, h('div', { style: 'margin-top:16px' }, h('button.btn', { type: 'button', onclick: renderAccount }, 'Փորձել կրկին'))));
  }
  setHeader(true);
  paintAccount();
}
const sessionLost = (x) => { if (x.status === 401) { csrf = ''; go('/pioneer-card/login', { replace: true }); toast('Ձեր սեսիան ավարտվել է։ Մուտք գործեք կրկին։'); return true; } return false; };
async function refreshMe() { const me = await api('/me'); acc.me = me; return me; }

// Next reward the member is working towards: the cheapest available (or upcoming) one they cannot afford yet.
function nextGoal() {
  const bal = acc.me.balance, list = acc.rewards.filter((r) => !r.soldOut && !r.limitReached);
  const target = list.filter((r) => r.pointsCost > bal).sort((a, b) => a.pointsCost - b.pointsCost)[0];
  return { target, affordable: list.filter((r) => r.available && r.pointsCost <= bal).length };
}

function paintAccount() {
  const { me } = acc;
  const tabs = [['overview', 'Ակնարկ'], ['points', 'Միավորներ'], ['rewards', 'Պարգևներ'], ['transfer', 'Փոխանցում'], ['profile', 'Պրոֆիլ']];
  const body = h('div');
  const setTab = (k) => { acc.tab = k; paintAccount(); };
  const { target, affordable } = nextGoal();
  const progress = target
    ? h('div.prog', {}, h('div.t', {}, h('span', {}, `Մինչև «${target.title}»`), h('span', {}, `${num(me.balance)} / ${num(target.pointsCost)}`)), h('div.pbar', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': target.pointsCost, 'aria-valuenow': me.balance }, h('i', { style: `width:${Math.min(100, (me.balance / target.pointsCost) * 100).toFixed(1)}%` })))
    : h('div.prog', {}, h('div.t', {}, h('span', {}, affordable ? `Դուք կարող եք ստանալ ${affordable} պարգև` : 'Պարգևները շուտով կհայտնվեն այստեղ')), h('div.pbar', {}, h('i', { style: `width:${affordable ? 100 : 0}%` })));
  view.replaceChildren(
    h('div.acc-head', {}, h('div', {}, h('span.tag', {}, 'MAGICAL PIONEER COMMUNITY'), h('h1', {}, me.card.hasName ? `Բարի գալուստ, ${me.card.firstName || me.card.displayName}` : 'Բարի գալուստ, Pioneer')),
      h('p.muted', { style: 'font-size:14px' }, `Անդամ՝ ${fmtDay.format(new Date(me.card.memberSince))}-ից`)),
    h('div.acc-grid', {},
      h('div.panel', { style: 'display:grid;place-items:center;padding:26px' }, cardEl(me.card, '.wcard'), h('p.muted', { style: 'font-size:12.5px;margin-top:12px;text-align:center' }, 'Ձեր վիրտուալ Pioneer Card-ը')),
      h('div.panel.bal', {}, h('div.lab', {}, 'PIONEER POINTS · ՀԱՍԱՆԵԼԻ ՄԻԱՎՈՐՆԵՐ'), h('div.num', {}, num(me.balance), h('small', {}, 'PTS')),
        h('p.muted', { style: 'font-size:14px' }, 'Դուք Magical Pioneer համայնքի անդամ եք։'), progress,
        h('div.acts', {}, h('button.btn.p', { type: 'button', onclick: () => setTab('transfer') }, 'Փոխանցել միավորներ'), h('button.btn', { type: 'button', onclick: () => setTab('rewards') }, 'Պարգևներ')))),
    h('div.stats', {}, [[me.stats.earned, 'Ստացված բոնուսներ'], [me.stats.received, 'Ստացված փոխանցումներ'], [me.stats.transferred, 'Ուղարկված փոխանցումներ'], [me.stats.spent, 'Ծախսված պարգևների վրա']].map(([v, l]) => h('div.stat', {}, h('b', {}, num(v)), h('span', {}, l)))),
    h('div.tabs-p', { role: 'tablist' }, tabs.map(([k, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': acc.tab === k, onclick: () => setTab(k) }, l))),
    body);
  view.querySelector('.wcard').style.cssText = 'width:100%;max-width:420px';
  ({ overview: tabOverview, points: tabPoints, rewards: tabRewards, transfer: tabTransfer, profile: tabProfile })[acc.tab](body);
}

function txList(items) {
  if (!items.length) return h('div.empty-p', {}, h('div.ic', {}, svg('spark')), h('b', {}, 'Գործարքներ դեռ չկան'), 'Ձեր միավորների շարժը կցուցադրվի այստեղ։');
  return h('ul.tx', {}, items.map((t) => {
    const pos = t.amount > 0;
    const detail = [t.counterparty ? `${t.type === 'transfer_out' ? 'Ստացող՝' : 'Ուղարկող՝'} ${t.counterparty.name} (${t.counterparty.number})` : t.description, when(t.createdAt), t.reference].filter(Boolean).join(' · ');
    return h('li', {}, h('span.ti' + (t.type.startsWith('transfer') ? (pos ? '.in' : '.out') : ''), {}, svg(t.type === 'redemption' || t.type === 'partner_redemption' ? 'gift' : t.type.startsWith('transfer') ? 'arrow' : 'star')),
      h('div.d', {}, h('b', {}, TX_LABELS[t.type] || t.type), h('span', {}, detail)),
      h('div.a' + (pos ? '.pos' : ''), {}, (pos ? '+' : '') + num(t.amount), h('small', {}, `մնացորդ՝ ${num(t.balanceAfter)}`)));
  }));
}

function tabOverview(body) {
  const ann = h('div', {}, h('p.muted', {}, 'Բեռնվում է…'));
  body.append(h('div.acc-grid', {},
    h('div.panel', {}, h('h2', {}, 'Վերջին ակտիվությունը'), txList(acc.me.recent), acc.me.recent.length >= 5 ? h('button.btn', { type: 'button', style: 'margin-top:14px', onclick: () => { acc.tab = 'points'; paintAccount(); } }, 'Ամբողջ պատմությունը') : null),
    h('div.panel', {}, h('h2', {}, 'Հայտարարություններ'), ann)),
  h('div', { style: 'margin-top:20px' }, comingSoon()));
  api('/announcements').then((d) => {
    ann.replaceChildren(...(d.items.length ? d.items.map((a) => h('div.ann', {}, h('b', {}, a.title), h('time', { datetime: a.createdAt }, fmtDay.format(new Date(a.createdAt))), a.body ? h('p', {}, a.body) : null))
      : [h('div.empty-p', { style: 'padding:20px 8px' }, h('div.ic', {}, svg('rocket')), h('b', {}, 'Նոր հայտարարություններ չկան'), 'Magical-ի միջոցառումների, հնարավորությունների և անդամների առաջարկների մասին նորությունները կհայտնվեն այստեղ։')]));
  }).catch((x) => { if (!sessionLost(x)) ann.replaceChildren(h('p.muted', {}, x.message)); });
}

function comingSoon() {
  const item = (ic, t, p) => h('div.soon', {}, h('div.ic', {}, svg(ic)), h('b', {}, t), h('p', {}, p));
  return h('div.panel', {}, h('h2', {}, 'Շուտով Pioneer-ում ', h('small', {}, 'պլանավորվող ուղղություններ, դեռ հաստատված չեն')),
    h('div.soon-grid', {},
      item('spark', 'Նոր պարգևներ', 'Magical-ը աշխատում է Pioneer անդամների համար նոր պարգևների և դասընթացների առաջարկների վրա։'),
      item('star', 'Միավորներ ակտիվության համար', 'Ուսումնասիրում ենք միավորներ վաստակելու լրացուցիչ եղանակներ։'),
      item('rocket', 'Համայնքային միջոցառումներ', 'Pioneer համայնքի հանդիպումների և միջոցառումների մասին կտեղեկացնենք այստեղ։')),
    h('p.muted', { style: 'font-size:12.5px;margin-top:12px' }, 'Այս բաժինը նկարագրում է հնարավոր ապագա ուղղություններ և խոստում չէ։ Հասանելի առավելությունները միշտ նշված են «Պարգևներ» բաժնում։'));
}

async function tabPoints(body) {
  const s = acc.me.stats;
  const list = h('div', {}, h('p.muted', {}, 'Բեռնվում է…')), pager = h('div', { style: 'display:flex;gap:10px;justify-content:center;align-items:center;margin-top:16px;color:var(--mut);font-size:14px' });
  body.append(h('div.panel', {}, h('h2', {}, 'Միավորների ամփոփում'),
    h('dl.kv2', {}, h('dt', {}, 'Հասանելի միավորներ'), h('dd', {}, h('b', {}, num(acc.me.balance))), h('dt', {}, 'Ստացված բոնուսներ'), h('dd', {}, num(s.earned)), h('dt', {}, 'Ստացված փոխանցումներ'), h('dd', {}, num(s.received)),
      h('dt', {}, 'Ուղարկված փոխանցումներ'), h('dd', {}, num(s.transferred)), h('dt', {}, 'Ծախսված պարգևների վրա'), h('dd', {}, num(s.spent)), s.deducted ? [h('dt', {}, 'Ադմինիստրատիվ նվազեցումներ'), h('dd', {}, num(s.deducted))] : null)),
  h('div.panel', { style: 'margin-top:20px' }, h('h2', {}, 'Գործարքների պատմություն'), list, pager));
  async function load() {
    try {
      const d = await api(`/transactions?page=${acc.txPage}&pageSize=15`);
      acc.txPage = d.page;
      list.replaceChildren(txList(d.items));
      const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
      pager.replaceChildren(...(pages > 1 ? [h('button.btn', { type: 'button', disabled: d.page <= 1, onclick: () => { acc.txPage--; load(); } }, '← Նախորդ'), h('span', {}, `${d.page} / ${pages}`), h('button.btn', { type: 'button', disabled: d.page >= pages, onclick: () => { acc.txPage++; load(); } }, 'Հաջորդ →')] : []));
    } catch (x) { if (!sessionLost(x)) list.replaceChildren(h('p.muted', {}, x.message)); }
  }
  await load();
}

function dialog(title, content, cls = '') {
  const prev = document.activeElement;
  const close = () => { d.remove(); document.removeEventListener('keydown', esc); prev?.focus?.(); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const d = h('div.dlg' + cls, { role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e) => { if (e.target === d) close(); } }, h('div.box', {}, h('h2', {}, title), content));
  document.addEventListener('keydown', esc);
  document.body.append(d);
  (d.querySelector('button.p') || d.querySelector('button'))?.focus();
  return close;
}

function tabRewards(body) {
  const bal = acc.me.balance, items = acc.rewards;
  const available = items.filter((r) => !r.upcoming), upcoming = items.filter((r) => r.upcoming);
  const benefit = (r) => [r.discountPercent ? `${r.discountPercent}% զեղչ` : '', r.discountAmount ? `${num(r.discountAmount)} ֏ զեղչ` : ''].filter(Boolean).join(' · ');
  const card = (r) => {
    const locked = r.upcoming || r.soldOut || r.limitReached;
    const enough = bal >= r.pointsCost;
    const chip = r.upcoming ? h('span.chip.soon', {}, 'Շուտով') : r.soldOut ? h('span.chip', {}, 'Սպառված է') : r.limitReached ? h('span.chip', {}, 'Օգտագործված') : enough ? h('span.chip.ok', {}, 'Հասանելի է') : h('span.chip', {}, `ևս ${num(r.pointsCost - bal)}`);
    const action = r.upcoming ? h('button.btn', { type: 'button', disabled: true }, `Հասանելի կլինի ${fmtDay.format(new Date(r.availableFrom))}`)
      : locked ? h('button.btn', { type: 'button', disabled: true }, r.soldOut ? 'Սպառված է' : 'Սահմանաչափը լրացել է')
      : enough ? h('button.btn.p', { type: 'button', onclick: () => redeem(r) }, 'Ստանալ')
      : h('button.btn', { type: 'button', disabled: true }, 'Բավարար միավորներ չկան');
    return h('article.rcard' + (locked || !enough ? '.locked' : ''), {},
      h('div.top', {}, h('div.ic', {}, svg(locked ? 'lock' : r.icon)), chip),
      h('h3', {}, r.title), benefit(r) ? h('div.ben', {}, benefit(r)) : null, h('p', {}, r.description || (r.kind === 'course_discount' ? 'Զեղչ Magical-ի դասընթացի համար։' : 'Pioneer պարգև։')),
      r.availabilityNote ? h('p', { style: 'flex:none;margin-top:6px;font-size:12.5px' }, r.availabilityNote) : null,
      h('div.cost', {}, h('span', {}, 'Պահանջվում է'), h('b', {}, `${num(r.pointsCost)} PTS`)),
      h('div.pbar', { role: 'progressbar', 'aria-label': 'Առաջընթաց', 'aria-valuemin': 0, 'aria-valuemax': r.pointsCost, 'aria-valuenow': Math.min(bal, r.pointsCost) }, h('i', { style: `width:${Math.min(100, (bal / r.pointsCost) * 100).toFixed(1)}%` })), action);
  };
  const hist = h('div', {}, h('p.muted', {}, 'Բեռնվում է…'));
  body.append(
    h('div.panel', {}, h('h2', {}, 'Հասանելի պարգևներ և զեղչեր'), available.length ? h('div.rw', {}, available.map(card))
      : h('div.empty-p', {}, h('div.ic', {}, svg('gift')), h('b', {}, 'Պարգևների կատալոգը պատրաստվում է'), 'Առաջին դասընթացների զեղչերն ու պարգևները կհայտնվեն այստեղ, հենց Magical-ը դրանք հրապարակի։ Ձեր միավորները պահպանվում են։')),
    upcoming.length ? h('div.panel', { style: 'margin-top:20px' }, h('h2', {}, 'Շուտով'), h('div.rw', {}, upcoming.map(card))) : null,
    h('div.panel', { style: 'margin-top:20px' }, h('h2', {}, 'Իմ հայտերը'), hist),
    h('div', { style: 'margin-top:20px' }, comingSoon()));
  api('/redemptions').then((d) => {
    const ready = d.items.filter((r) => r.giftCard?.state === 'ready');
    const chip = (r) => h('span.gst.' + r.status, {}, GIFT_STATUS[r.status] || r.status);
    hist.replaceChildren(
      ready.length ? h('div.gc-ready', {}, h('p.gc-ready-t', {}, svg('gift'), ready.length === 1 ? 'Ձեր նվերը պատրաստ է ստացման' : `Պատրաստ է ստացման՝ ${ready.length} նվեր`),
        h('div.gc-minis', {}, ready.map((r) => h('button.gc-mini', { type: 'button', onclick: () => openGift(r), 'aria-label': `Դիտել նվերի քարտը՝ ${r.rewardTitle}` },
          h('small', {}, 'Նվերի ստացման քարտ'), h('b', {}, r.rewardTitle), h('span', {}, r.giftCard.code))))) : null,
      d.items.length ? h('ul.tx.gc-list', {}, d.items.map((r) => h('li', {}, h('span.ti', {}, svg('gift')),
        h('div.d', {}, h('b', {}, r.rewardTitle), h('span', {}, [r.rewardBenefit, when(r.createdAt)].filter(Boolean).join(' · ')), chip(r),
          r.giftCard ? h('button.btn.sm' + (r.giftCard.state === 'ready' ? '.p' : ''), { type: 'button', onclick: () => openGift(r) }, svg('gift'), 'Դիտել նվերի քարտը') : null),
        h('div.a', {}, h('span.ref', { style: 'font-size:13px' }, r.reference), h('small', {}, `${num(r.points)} PTS`)))))
      : h('div.empty-p', { style: 'padding:20px 8px' }, 'Դուք դեռ պարգևներ չեք ստացել։'));
  }).catch((x) => { if (!sessionLost(x)) hist.replaceChildren(h('div.banner', { role: 'alert' }, x.message, ' ', h('button.btn.sm', { type: 'button', onclick: () => { acc.tab = 'rewards'; paintAccount(); } }, 'Փորձել կրկին'))); });
}

// ---------- gift card for an approved request (data comes only from GET /redemptions of the signed-in card) ----------
function giftCardEl(r) {
  const g = r.giftCard, c = acc.me.card, ready = g.state === 'ready';
  return h('article.gcard' + (ready ? '' : '.used'), { 'aria-label': `Նվերի ստացման քարտ՝ ${r.rewardTitle}` },
    h('div.gc-head', {}, h('span.gc-brand', {}, h('img', { src: '/assets/magical-m.png', alt: '' }), 'MAGICAL'), h('span.gc-tag', {}, 'PIONEER REWARDS')),
    h('p.gc-kicker', {}, 'Նվերի ստացման քարտ'),
    h('h3.gc-title', {}, r.rewardTitle),
    r.rewardBenefit ? h('p.gc-ben', {}, r.rewardBenefit) : null,
    h('p.gc-state', {}, h('i', { 'aria-hidden': 'true' }), ready ? 'Հաստատված է · Պատրաստ է ստացման' : `Տրամադրված է${g.collectedAt ? ' · ' + fmtDay.format(g.collectedAt) : ''}`),
    h('div.gc-cut', { 'aria-hidden': 'true' }),
    h('div.gc-code', {}, h('small', {}, 'Նվերի կոդ'), h('b', { translate: 'no' }, g.code)),
    h('dl.gc-meta', {},
      h('div', {}, h('dt', {}, 'Ստացող'), h('dd', {}, c.displayName)),
      h('div', {}, h('dt', {}, 'Քարտ'), h('dd', {}, '•••• ' + c.number.slice(-4))),
      h('div', {}, h('dt', {}, 'Հաստատվել է'), h('dd', {}, fmtDay.format(g.approvedAt))),
      h('div', {}, h('dt', {}, 'Հայտ'), h('dd', {}, r.reference))),
    ready ? h('p.gc-ins', {}, 'Ձեր հայտը հաստատված է։ Նվերը ստանալու համար ներկայացրեք այս քարտը մեր գրասենյակում կամ զանգահարեք ստորև նշված հեռախոսահամարներով։') : null,
    ready ? h('div.gc-phones', {}, GIFT_PHONES.map(([t, tel]) => h('a', { href: `tel:${tel}` }, svg('phone'), t))) : null);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure context or denied: fall back */ }
  const t = h('textarea', { readonly: true, style: 'position:fixed;opacity:0;left:-9999px' }); t.value = text;
  document.body.append(t); t.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* unsupported */ }
  t.remove(); return ok;
}

function printGift(el) {
  const box = h('div', { id: 'gc-print' }, el.cloneNode(true));
  // the gift card prints on A5; the @page rule exists only while this prints
  const page = h('style', {}, '@page{size:A5 portrait;margin:14mm}');
  document.head.append(page); document.body.append(box); document.body.classList.add('printing-gift');
  const done = () => { document.body.classList.remove('printing-gift'); box.remove(); page.remove(); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
  if (!('onafterprint' in window)) setTimeout(done, 60_000); // browsers without afterprint
}

function openGift(r) {
  const el = giftCardEl(r);
  const live = h('span.sr', { 'aria-live': 'polite' });
  const copy = h('button.btn.p', { type: 'button' }, svg('copy'), 'Պատճենել կոդը');
  copy.addEventListener('click', async () => {
    const ok = await copyText(r.giftCard.code);
    live.textContent = ok ? 'Կոդը պատճենված է' : '';
    if (!ok) return toast('Չհաջողվեց պատճենել։ Նշեք կոդը և պատճենեք ձեռքով։');
    copy.replaceChildren(svg('check'), 'Պատճենված է'); copy.classList.add('done');
    setTimeout(() => { copy.replaceChildren(svg('copy'), 'Պատճենել կոդը'); copy.classList.remove('done'); }, 2200);
  });
  const close = dialog('Նվերի քարտ', h('div', {}, el, live,
    h('div.acts.gc-acts', {}, h('button.btn', { type: 'button', onclick: () => close() }, 'Փակել'), h('button.btn', { type: 'button', onclick: () => printGift(el) }, svg('print'), 'Տպել'), copy)), '.gc-dlg');
}

function redeem(r) {
  const key = newKey(); // one key per confirmed intent: retries/double clicks are replayed, never repeated
  const msg = h('div.banner', { role: 'alert', hidden: true });
  const ok = h('button.btn.p', { type: 'button' }, `Հաստատել (${num(r.pointsCost)} PTS)`);
  const content = h('div', {},
    h('div.sum', {}, h('dl.kv2', {}, h('dt', {}, 'Պարգև'), h('dd', {}, h('b', {}, r.title)), r.discountPercent || r.discountAmount ? [h('dt', {}, 'Առավելություն'), h('dd', {}, [r.discountPercent ? `${r.discountPercent}% զեղչ` : '', r.discountAmount ? `${num(r.discountAmount)} ֏ զեղչ` : ''].filter(Boolean).join(' · '))] : null,
      h('dt', {}, 'Միավորներ'), h('dd', {}, `${num(r.pointsCost)} PTS`), h('dt', {}, 'Մնացորդը հետո'), h('dd', {}, `${num(acc.me.balance - r.pointsCost)} PTS`))),
    h('p.muted', { style: 'font-size:13px;margin-top:12px' }, r.kind === 'course_discount' ? 'Հաստատելուց հետո կստանաք հայտի կոդ։ Ներկայացրեք այն Magical-ի աշխատակցին՝ զեղչը կիրառելու համար։ Զեղչը ավտոմատ չի կիրառվում որևէ վճարման համակարգում։' : 'Հաստատելուց հետո կստանաք հայտի կոդ, որով Magical-ի աշխատակիցը կտրամադրի պարգևը։'),
    msg, h('div.acts', {}, h('button.btn', { type: 'button', onclick: () => close() }, 'Չեղարկել'), ok));
  const close = dialog('Ստանա՞լ պարգևը', content);
  ok.addEventListener('click', async () => {
    ok.disabled = true; ok.setAttribute('aria-busy', 'true'); msg.hidden = true;
    try {
      const d = await api('/redemptions', { method: 'POST', body: { rewardId: r.id }, key });
      close();
      await Promise.all([refreshMe(), api('/rewards').then((x) => { acc.rewards = x.items; })]);
      paintAccount();
      dialog('Պարգևը ձևակերպված է', h('div.success', {}, h('div.ic', {}, svg('gift')), h('p', {}, `«${d.redemption.rewardTitle}»`), h('p.muted', { style: 'font-size:13px;margin:10px 0 6px' }, 'Ձեր հայտի կոդը'), h('div.ref', {}, d.redemption.reference),
        h('p.muted', { style: 'font-size:13px;margin-top:10px' }, 'Կոդը պահպանված է «Իմ հայտերը» բաժնում։'), h('div.acts', { style: 'justify-content:center' }, h('button.btn.p', { type: 'button', onclick: (e) => e.target.closest('.dlg').remove() }, 'Լավ'))));
    } catch (x) {
      if (sessionLost(x)) { close(); return; }
      msg.textContent = x.message; msg.hidden = false;
      ok.disabled = false; ok.removeAttribute('aria-busy');
    }
  });
}

function tabTransfer(body) {
  const st = { step: 1, cardNo: '', recipient: null, pending: null };
  const box = h('div.tr-form');
  body.append(h('div.panel', {}, h('h2', {}, 'Փոխանցել Pioneer միավորներ'), box));
  const steps = () => h('div.tsteps', {}, ['1. Ստացող', '2. Քանակ', '3. Հաստատում'].map((t, i) => h('span' + (st.step === i + 1 ? '.on' : ''), {}, t)));
  const err = (text) => h('div.banner', { role: 'alert' }, text);
  function step1(msg) {
    st.step = 1;
    const input = h('input.code', { id: 'rc', inputmode: 'numeric', autocomplete: 'off', maxlength: 9, placeholder: '0000 0000', value: st.cardNo ? fmtCardNo(st.cardNo) : '' });
    input.addEventListener('input', () => { const d = input.value.replace(/\D/g, '').slice(0, 8); input.value = d.length > 4 ? `${d.slice(0, 4)} ${d.slice(4)}` : d; });
    const btn = h('button.btn.p', { type: 'submit' }, 'Գտնել ստացողին');
    box.replaceChildren(steps(), h('form', { novalidate: true, style: 'padding:0;border:0;background:none', onsubmit: async (e) => {
      e.preventDefault();
      const n = normalizeCardNo(input.value);
      if (!n) return step1(PIONEER_MSG.cardNumber);
      if (n === acc.me.card.number) return step1('Չեք կարող միավորներ փոխանցել ձեր սեփական քարտին։');
      btn.disabled = true;
      try { const d = await api('/recipient', { method: 'POST', body: { cardNumber: n } }); st.cardNo = n; st.recipient = d.recipient; step2(); }
      catch (x) { if (!sessionLost(x)) step1(x.message); }
    } }, h('label', { for: 'rc' }, 'Ստացողի 8 նիշանոց Pioneer Card համարը'), input, msg ? err(msg) : null,
    h('p.muted', { style: 'font-size:13px;margin-top:10px' }, `Հասանելի է՝ ${num(acc.me.balance)} PTS։ Ստացողի անունը կցուցադրվի հաստատումից առաջ։`), h('div.acts', {}, btn)));
    input.focus();
  }
  const who = () => h('div.who', {}, h('span.av', { 'aria-hidden': 'true' }, (st.recipient.hasName ? st.recipient.name : 'P').slice(0, 1).toUpperCase()), h('div', {}, h('b', {}, st.recipient.name), h('span', {}, `Pioneer Card ${st.recipient.number}`)));
  function step2(msg, val = '') {
    st.step = 2;
    const amount = h('input.code', { id: 'am', inputmode: 'numeric', autocomplete: 'off', maxlength: 7, placeholder: '0', value: val });
    amount.addEventListener('input', () => { amount.value = amount.value.replace(/\D/g, '').slice(0, 7); });
    box.replaceChildren(steps(), who(), h('form', { novalidate: true, style: 'padding:0;border:0;background:none', onsubmit: (e) => {
      e.preventDefault();
      const n = parsePoints(amount.value);
      if (!n) return step2(PIONEER_MSG.amount, amount.value);
      if (n > acc.me.balance) return step2(`Բավարար միավորներ չկան։ Հասանելի է՝ ${num(acc.me.balance)} PTS։`, amount.value);
      confirm(n);
    } }, h('label', { for: 'am' }, 'Միավորների քանակ'), amount, msg ? err(msg) : null, h('p.muted', { style: 'font-size:13px;margin-top:10px' }, `Հասանելի է՝ ${num(acc.me.balance)} PTS`),
    h('div.acts', {}, h('button.btn', { type: 'button', onclick: () => step1() }, '← Փոխել ստացողին'), h('button.btn.p', { type: 'submit' }, 'Շարունակել'))));
    amount.focus();
  }
  function confirm(n) {
    st.step = 3;
    box.replaceChildren(steps(), who(), h('p.muted', {}, 'Ստուգեք տվյալները և հաստատեք։'));
    // Same recipient + amount after "Back" or an unanswered request keeps its key, so a request that did reach the server is replayed, not repeated.
    const sig = `${st.cardNo}:${n}`;
    if (st.pending?.sig !== sig) st.pending = { sig, key: newKey() };
    const key = st.pending.key;
    const msg = h('div.banner', { role: 'alert', hidden: true });
    const ok = h('button.btn.p', { type: 'button' }, 'Հաստատել փոխանցումը');
    const close = dialog('Հաստատե՞լ փոխանցումը', h('div', {},
      h('div.sum', {}, h('dl.kv2', {}, h('dt', {}, 'Ստացող'), h('dd', {}, h('b', {}, st.recipient.name)), h('dt', {}, 'Քարտ'), h('dd', {}, st.recipient.number), h('dt', {}, 'Քանակ'), h('dd', {}, h('b', {}, `${num(n)} PTS`)), h('dt', {}, 'Ձեր մնացորդը հետո'), h('dd', {}, `${num(acc.me.balance - n)} PTS`))),
      h('p.muted', { style: 'font-size:13px;margin-top:12px' }, 'Համոզվեք, որ ստացողի անունը ճիշտ է։ Կատարված փոխանցումը հնարավոր չէ չեղարկել ինքնուրույն։'),
      msg, h('div.acts', {}, h('button.btn', { type: 'button', onclick: () => { close(); step2('', String(n)); } }, 'Հետ'), ok)));
    ok.addEventListener('click', async () => {
      ok.disabled = true; ok.setAttribute('aria-busy', 'true'); msg.hidden = true;
      try {
        const d = await api('/transfers', { method: 'POST', body: { cardNumber: st.cardNo, amount: n }, key });
        st.pending = null; close();
        await refreshMe();
        acc.tab = 'transfer'; paintAccount();
        const panel = view.querySelector('.tr-form');
        panel.replaceChildren(h('div.success', {}, h('div.ic', {}, svg('arrow')), h('h3', { style: 'font-size:20px' }, `${num(d.transfer.amount)} PTS ուղարկված է`), h('p.muted', {}, `${d.transfer.recipient.name} · ${d.transfer.recipient.number}`),
          h('p.muted', { style: 'font-size:13px;margin:12px 0 4px' }, 'Գործարքի հղում'), h('div.ref', {}, d.transfer.reference), h('p.muted', { style: 'margin-top:10px' }, `Նոր մնացորդ՝ ${num(d.balance)} PTS`),
          h('div.acts', { style: 'justify-content:center' }, h('button.btn', { type: 'button', onclick: () => { acc.tab = 'points'; paintAccount(); } }, 'Պատմություն'), h('button.btn.p', { type: 'button', onclick: () => { acc.tab = 'transfer'; paintAccount(); } }, 'Նոր փոխանցում'))));
      } catch (x) {
        if (sessionLost(x)) { close(); return; }
        msg.textContent = x.message; msg.hidden = false;
        ok.disabled = false; ok.removeAttribute('aria-busy');
        if (x.code === 'insufficient_points' || x.code === 'recipient_not_found') refreshMe().catch(() => {});
      }
    });
  }
  step1();
}

function tabProfile(body) {
  const c = acc.me.card;
  body.append(h('div.acc-grid', {},
    h('div.panel', {}, h('h2', {}, 'Պրոֆիլ'), h('dl.kv2', {},
      h('dt', {}, 'Անուն'), h('dd', {}, c.hasName ? c.displayName : h('span', {}, 'Pioneer Member', h('div.muted', { style: 'font-size:13px' }, 'Անունը կարող է ավելացնել Magical-ի աշխատակիցը։'))),
      h('dt', {}, 'Քարտի համար'), h('dd', {}, fmtCardNo(c.number)),
      h('dt', {}, 'Անդամ է'), h('dd', {}, fmtDay.format(new Date(c.memberSince)) + '-ից'),
      h('dt', {}, 'Կարգավիճակ'), h('dd', {}, 'Ակտիվ'))),
    h('div.panel', {}, h('h2', {}, 'Գաղտնիություն և անվտանգություն'), h('ul', { style: 'color:var(--mut);font-size:14px;line-height:1.7;padding-left:18px;margin:0' },
      h('li', {}, 'Ձեր անձնական տվյալները (օր.՝ հեռախոսահամարը) կառավարում է Magical-ը և երբեք չեն ցուցադրվում այլ անդամներին։'),
      h('li', {}, 'Ձեզ միավորներ ուղարկողը տեսնում է միայն ձեր անունը (կամ «Pioneer Member») և քարտի համարի վերջին 4 նիշը։'),
      h('li', {}, 'Երբեք մի հայտնեք ձեր CVV կոդը որևէ մեկին, նույնիսկ Magical-ի աշխատակցին։ Կորցնելու դեպքում դիմեք Magical-ին՝ նոր կոդ ստանալու համար։'),
      h('li', {}, 'Ավարտելուց հետո սեղմեք «Դուրս գալ», հատկապես հանրային սարքերում։')))));
}

route();
