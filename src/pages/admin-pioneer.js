// Admin panel: "Pioneer Cards" section (cards, courses & rewards, redemptions, ledger, announcements, activity, settings).
// Uses the admin page's own helpers (h, api, modal, ...) passed in by src/pages/admin.js, so it shares its
// session, CSRF handling and look. Every action is enforced on the server; this file only renders.
import { cardHtml, fmtCardNo, ICON_KEYS, icon } from '../modules/pioneer-card-view.js';
import { TX_LABELS } from '../../shared/pioneer.js';

const CARD_ST = { active: 'Ակտիվ', inactive: 'Ապաակտիվ' };
// approved = gift card issued, waiting for pickup; fulfilled = handed over (unchanged meaning)
const RED_ST = { pending: 'Սպասող', approved: 'Հաստատված · սպասում է ստացման', fulfilled: 'Տրամադրված', cancelled: 'Չեղարկված' };
const RW_ST = { draft: 'Սևագիր', published: 'Հրապարակված', archived: 'Արխիվացված' };
const KIND = { course_discount: 'Դասընթացի զեղչ', reward: 'Պարգև' };
const ICON_LBL = { spark: 'Կայծ', code: 'Ծրագրավորում', design: 'Դիզայն', mobile: 'Մոբայլ', gift: 'Նվեր', star: 'Աստղ', book: 'Գիրք', rocket: 'Հրթիռ' };
const AUDIT = {
  'card.create': 'Քարտի ստեղծում', 'card.update_holder': 'Քարտատիրոջ տվյալների փոփոխություն', 'card.activate': 'Ակտիվացում', 'card.deactivate': 'Ապաակտիվացում',
  'card.cvv_reset': 'CVV-ի վերականգնում', 'card.unlock': 'Մուտքի ապակողպում', 'card.print': 'Քարտի տպում (A4 թերթ)', 'card.print_cvv_mismatch': 'Տպում․ սխալ CVV', 'card.cvv_stored': 'CVV-ն պահվեց տպման համար (գաղտնագրված)', 'cards.bulk_retire': 'Քարտերի զանգվածային ապաակտիվացում', 'points.adjust': 'Միավորների ճշգրտում', 'redemption.approve': 'Հայտի հաստատում (նվերի քարտ)', 'redemption.fulfill': 'Նվերի տրամադրում',
  'redemption.cancel': 'Հայտի չեղարկում', 'reward.create': 'Պարգևի ստեղծում', 'reward.update': 'Պարգևի փոփոխություն', 'reward.delete': 'Պարգևի ջնջում',
  'announcement.create': 'Հայտարարության ստեղծում', 'announcement.update': 'Հայտարարության փոփոխություն', 'settings.initial_bonus': 'Մեկնարկային բոնուսի փոփոխություն',
};
const SUBTABS = [['cards', 'Քարտեր'], ['rewards', 'Դասընթացներ և պարգևներ'], ['redemptions', 'Հայտեր'], ['ledger', 'Գործարքներ'], ['news', 'Հայտարարություններ'], ['audit', 'Ակտիվություն'], ['settings', 'Կարգավորումներ']];
const ui = { sub: 'cards', cards: { q: '', status: '', page: 1, mode: 'print' }, red: { q: '', status: 'pending', page: 1 }, led: { type: '', card: '', page: 1 }, audit: { page: 1 } };

const holderName = (c) => [c.firstName, c.lastName].filter(Boolean).join(' ');
const num = (n) => Number(n || 0).toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : '') + num(n);
const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export async function viewPioneer(box, kit) {
  const { h } = kit;
  const body = h('div');
  const tabs = h('div.subtabs', { role: 'tablist', 'aria-label': 'Pioneer Card' }, SUBTABS.map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': ui.sub === k, onclick: () => { ui.sub = k; box.replaceChildren(); viewPioneer(box, kit); } }, label)));
  box.append(tabs, body);
  const views = { cards: viewCards, rewards: viewRewards, redemptions: viewRedemptions, ledger: viewLedger, news: viewNews, audit: viewAudit, settings: viewSettings };
  await views[ui.sub](body, kit);
}

// ---------- shared small helpers ------------------------------------------------------
function fieldsKit(h) {
  const errs = {};
  const field = (label, input, key, { help, full } = {}) => {
    const e = h('div.err', { role: 'alert' }); errs[key] = { e, input };
    if (!input.id) input.id = 'f-' + key + '-' + Math.random().toString(36).slice(2, 7);
    return h('div' + (full ? '.full' : ''), {}, h('label', { for: input.id }, label), input, help ? h('p.help', {}, help) : null, e);
  };
  const show = (fields = {}) => {
    for (const [k, { e, input }] of Object.entries(errs)) {
      const m = fields[k] || ''; e.textContent = m; e.classList.toggle('on', !!m);
      if (m) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  };
  return { field, show };
}
function confirmBox(kit, title, text, okLabel = 'Հաստատել', { danger } = {}) {
  const { h, modal } = kit;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; close(); resolve(v); };
    const content = h('div', {}, h('p', { style: 'margin:0 0 18px;color:var(--mut)' }, text),
      h('div.macts', {}, h('button.btn' + (danger ? '' : '.p'), { type: 'button', style: danger ? 'border-color:#f87171;color:#fca5a5' : null, onclick: () => finish(true) }, okLabel), h('button.btn', { type: 'button', onclick: () => finish(false) }, 'Չեղարկել')));
    const close = modal(title, content, { small: true });
    // closing with × / Esc / backdrop resolves false
    const obs = new MutationObserver(() => { if (!content.isConnected) { obs.disconnect(); if (!done) { done = true; resolve(false); } } });
    obs.observe(document.body, { childList: true });
  });
}
// One card through the same A4 print sheet (own list, the multi-card selection is left alone).
// cvv: a code issued just now (new card / CVV reset) when no encrypted copy is on file; page memory only.
function printOne(kit, card, cvv) {
  const entry = { id: card.id, number: card.number, firstName: card.firstName, lastName: card.lastName, cvvOnFile: !!card.cvvOnFile, ...(cvv && !card.cvvOnFile && { cvv }) };
  printDialog(kit, undefined, new Map([[card.id, entry]]));
}
const cardPreview = (kit, card) => { const d = kit.h('div.pc-wrap'); d.innerHTML = cardHtml(card); return d; };
const errBox = (h, e) => h('div.empty', {}, e.message);
// Full error text: the general message plus the server's per-field details (e.g. «Անվավեր կարգավիճակ։»).
const errText = (e) => [e.message, ...Object.values(e.fields || {})].filter(Boolean).join(' ');
function errorDialog(kit, title, text) {
  const { h, modal } = kit;
  const close = modal(title, h('div', {}, h('p', { role: 'alert', style: 'margin:0 0 18px;color:#fca5a5' }, text),
    h('div.macts', {}, h('button.btn.p', { type: 'button', onclick: () => close() }, 'Լավ'))), { small: true });
}
const OUTDATED_SERVER = 'Սերվերը դեռ չի աջակցում հայտերի հաստատմանը (նվերի քարտեր)։ Կայքի նոր տարբերակը տեղադրված է, բայց սերվերը վերագործարկված չէ, և 003 միգրացիան կիրառված չէ։ ' +
  'Կազմեք տվյալների բազայի պահուստային պատճեն և վերագործարկեք սերվերը։ Մինչ այդ հայտերը կարելի է միայն չեղարկել։';

// ---------- print selection (A4 sheet, 1-8 cards) ------------------------------------
// Kept in page memory only (never localStorage/URL). A CVV is present only when it was just issued in this
// page (new card / CVV reset) or typed in the print dialog, and is wiped when the dialog closes.
const PRINT_MAX = 8;
try { localStorage.removeItem('magical.pioneer.duplex'); } catch { /* storage unavailable */ } // leftover of the removed duplex settings
const printSel = new Map(); // card id -> { id, number, firstName, lastName, cvv? } in selection order
let onPrintSel = () => {};
const selCard = (c, cvv) => {
  if (printSel.has(c.id)) { if (cvv) printSel.get(c.id).cvv = cvv; return true; }
  if (printSel.size >= PRINT_MAX || c.status !== 'active') return false;
  printSel.set(c.id, { id: c.id, number: c.number, firstName: c.firstName, lastName: c.lastName, cvvOnFile: !!c.cvvOnFile, ...(cvv && { cvv }) });
  return true;
};

// ---------- bulk selection (retire / "delete"), page memory only ------------------------------
const manageSel = new Set(); // card ids

// ---------- cards -----------------------------------------------------------------------
async function viewCards(box, kit) {
  const { h, api, pager, debounce, when } = kit;
  const s = ui.cards;
  const list = h('div'), count = h('span.count'), statsRow = h('div.stat-row');
  const search = h('input', { type: 'search', placeholder: 'Որոնում՝ քարտի համար, անուն, հեռախոս', 'aria-label': 'Որոնում', value: s.q, maxlength: 100, oninput: debounce((e) => { s.q = e.target.value; s.page = 1; load(); }) });
  const sel = h('select', { 'aria-label': 'Կարգավիճակ', onchange: (e) => { s.status = e.target.value; s.page = 1; load(); } }, h('option', { value: '' }, 'Բոլոր քարտերը'), Object.entries(CARD_ST).map(([k, v]) => h('option', { value: k, selected: s.status === k }, v)));

  // selection bar
  const selCount = h('b'), selNote = h('p.msg', { role: 'status', 'aria-live': 'polite' });
  const printBtn = h('button.btn.sm.p', { type: 'button', onclick: () => printDialog(kit, refreshSel) }, 'Տպել ընտրված քարտերը');
  const clearBtn = h('button.btn.sm', { type: 'button', onclick: () => { printSel.clear(); refreshSel('Ընտրությունը չեղարկված է։'); } }, 'Չեղարկել ընտրությունը');
  const allBtn = h('button.btn.sm', { type: 'button', onclick: selectAll }, 'Ընտրել բոլորը');
  const selBar = h('div.psel', { role: 'group', 'aria-label': 'Տպման ընտրություն' }, h('span.psel-n', {}, 'Ընտրված է՝ ', selCount), allBtn, clearBtn, printBtn, selNote);
  const checks = new Map(); // card id -> checkbox on the current page
  function refreshSel(note, isErr) {
    selCount.textContent = `${printSel.size} / ${PRINT_MAX} քարտ`;
    printBtn.disabled = !printSel.size; clearBtn.disabled = !printSel.size;
    printBtn.title = printSel.size ? '' : 'Նախ ընտրեք առնվազն մեկ քարտ';
    for (const [id, cb] of checks) { cb.checked = printSel.has(id); cb.closest('tr')?.classList.toggle('picked', cb.checked); }
    if (note !== undefined) { selNote.className = 'msg' + (isErr ? ' err' : ''); selNote.textContent = note; }
  }
  onPrintSel = refreshSel;
  async function selectAll() {
    // every active card matching the current search, in list order, up to the free places
    if (printSel.size >= PRINT_MAX) return refreshSel(`Ընտրությունն արդեն լրացված է (${PRINT_MAX} / ${PRINT_MAX})։ Տպեք այս թերթը կամ հանեք քարտեր ընտրությունից։`, true);
    allBtn.disabled = true;
    try {
      const d = await api('/pioneer/cards?' + new URLSearchParams({ q: s.q, status: 'active', page: 1, pageSize: 100 }));
      const fresh = d.items.filter((c) => !printSel.has(c.id));
      const room = PRINT_MAX - printSel.size;
      fresh.slice(0, room).forEach((c) => selCard(c));
      if (!fresh.length) refreshSel(d.items.length ? 'Բոլոր համապատասխան ակտիվ քարտերն արդեն ընտրված են։' : 'Ընտրելու համար ակտիվ քարտեր չկան։');
      else if (fresh.length > room) refreshSel(`Գտնվել է ${d.total} ակտիվ քարտ, իսկ մեկ թերթում տեղավորվում է առավելագույնը ${PRINT_MAX}-ը․ ավելացվել են ցուցակի առաջին ${room}-ը։ Մնացածը տպեք հաջորդ թերթով։`, true);
      else refreshSel(`Ընտրվեց ${fresh.length} քարտ։`);
    } catch (e) { if (e.message !== 'auth') refreshSel(e.message, true); }
    finally { allBtn.disabled = false; }
  }
  const toggle = (c, cb) => {
    if (!cb.checked) { printSel.delete(c.id); return refreshSel(''); }
    if (printSel.size >= PRINT_MAX) { cb.checked = false; return refreshSel(`Կարելի է ընտրել առավելագույնը ${PRINT_MAX} քարտ (մեկ A4 թերթ)։ Հանեք մեկ քարտ ընտրությունից՝ այս մեկն ավելացնելու համար։`, true); }
    selCard(c); refreshSel('');
  };

  // bulk retire bar (its own selection, any number of cards)
  const mCount = h('b'), mNote = h('p.msg', { role: 'status', 'aria-live': 'polite' });
  const mAll = h('button.btn.sm', { type: 'button', onclick: selectAllManaged }, 'Ընտրել բոլորը');
  const mClear = h('button.btn.sm', { type: 'button', onclick: () => { manageSel.clear(); refreshManage('Ընտրությունը չեղարկված է։'); } }, 'Չեղարկել ընտրությունը');
  const mDel = h('button.btn.sm.danger', { type: 'button', onclick: () => bulkDialog(kit, { ids: [...manageSel] }, afterBulk) }, 'Ջնջել ընտրվածները');
  const mDelAll = h('button.btn.sm.danger', { type: 'button', onclick: () => bulkDialog(kit, { all: true }, afterBulk) }, 'Ջնջել բոլոր քարտերը');
  const manageBar = h('div.psel', { role: 'group', 'aria-label': 'Զանգվածային գործողություններ' }, h('span.psel-n', {}, 'Ընտրված է՝ ', mCount), mAll, mClear, mDel, mDelAll, mNote);
  function refreshManage(note, isErr) {
    mCount.textContent = `${manageSel.size} քարտ`;
    mDel.disabled = !manageSel.size; mClear.disabled = !manageSel.size;
    for (const [id, cb] of checks) { cb.checked = manageSel.has(id); cb.closest('tr')?.classList.toggle('picked', cb.checked); }
    if (note !== undefined) { mNote.className = 'msg' + (isErr ? ' err' : ''); mNote.textContent = note; }
  }
  async function selectAllManaged() {
    // every card matching the current search and status filter, across all pages
    mAll.disabled = true;
    try {
      let page = 1, d;
      do { d = await api('/pioneer/cards?' + new URLSearchParams({ q: s.q, status: s.status, page, pageSize: 100 })); d.items.forEach((c) => manageSel.add(c.id)); page++; } while (page <= Math.ceil(d.total / d.pageSize) && manageSel.size < 5000);
      refreshManage(`Ընտրվեց ${manageSel.size} քարտ${s.q || s.status ? ' (ըստ ընթացիկ որոնման/ֆիլտրի)' : ''}։`);
    } catch (e) { if (e.message !== 'auth') refreshManage(e.message, true); }
    finally { mAll.disabled = false; }
  }
  function afterBulk() { manageSel.clear(); refreshManage(''); load(); }
  const modes = [['print', 'Տպում'], ['manage', 'Կառավարում (ջնջել/ապաակտիվացնել)']];
  const modeTabs = h('div.pmode', { role: 'tablist', 'aria-label': 'Ընտրության նպատակը' }, modes.map(([k, label]) =>
    h('button', { type: 'button', role: 'tab', 'aria-selected': s.mode === k, onclick: () => { if (s.mode === k) return; s.mode = k; box.replaceChildren(); viewCards(box, kit); } }, label)));

  box.append(statsRow, h('div.tools', {}, search, sel, h('button.btn.sm.p', { type: 'button', onclick: () => createCard(kit, load) }, '+ Նոր քարտ'), count), modeTabs, s.mode === 'manage' ? manageBar : selBar, list);
  if (s.mode === 'manage') refreshManage(); else refreshSel();
  const loadStats = async () => {
    try {
      const st = await api('/pioneer/stats');
      statsRow.replaceChildren(...[[st.cards, 'Քարտեր'], [st.active, 'Ակտիվ'], [st.activated, 'Մուտք գործած'], [num(st.points), 'Միավորներ շրջանառությունում'], [st.pendingRedemptions, 'Սպասող հայտեր']].map(([v, l]) => h('div', {}, h('b', {}, v), h('span', {}, l))));
    } catch { /* non-critical */ }
  };
  async function load() {
    loadStats();
    try {
      const d = await api('/pioneer/cards?' + new URLSearchParams({ q: s.q, status: s.status, page: s.page, pageSize: 25 }));
      s.page = d.page; count.textContent = `Ընդամենը՝ ${d.total}`;
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, s.q || s.status ? 'Քարտեր չեն գտնվել։' : 'Դեռ քարտեր չկան։ Ստեղծեք առաջին Pioneer Card-ը։')));
      checks.clear();
      const manage = s.mode === 'manage', isSel = (c) => (manage ? manageSel.has(c.id) : printSel.has(c.id));
      const pick = (c) => {
        const cb = manage
          ? h('input', { type: 'checkbox', checked: manageSel.has(c.id), 'aria-label': `Ընտրել՝ ${fmtCardNo(c.number)}` })
          : h('input', { type: 'checkbox', checked: printSel.has(c.id), disabled: c.status !== 'active' && !printSel.has(c.id),
            'aria-label': `Ընտրել տպման համար՝ ${fmtCardNo(c.number)}`, title: c.status === 'active' ? 'Ընտրել տպման համար' : 'Ապաակտիվ քարտը հնարավոր չէ տպել' });
        cb.onchange = manage ? () => { if (cb.checked) manageSel.add(c.id); else manageSel.delete(c.id); refreshManage(''); } : () => toggle(c, cb);
        checks.set(c.id, cb);
        return h('td.pick', {}, cb);
      };
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th.pick', {}, h('span.sr', {}, 'Ընտրություն')), ['Քարտի №', 'Քարտատեր', 'Հեռախոս', 'Միավորներ', 'Կարգավիճակ', 'Ստեղծվել է', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((c) => h('tr', { class: isSel(c) ? 'picked' : null },
          pick(c),
          h('td', {}, h('span.mono', {}, fmtCardNo(c.number))),
          h('td', {}, holderName(c) || h('span.muted', {}, 'Անանուն')),
          h('td', {}, c.phone || '—'),
          h('td', {}, h('b', {}, num(c.balance))),
          h('td', {}, h('span.st.' + c.status, {}, CARD_ST[c.status]), c.activatedAt ? null : h('span.muted', { style: 'margin-left:8px;font-size:12px' }, 'մուտք չի եղել')),
          h('td', {}, when(c.createdAt)),
          h('td.act', {}, h('button.btn.sm', { type: 'button', onclick: () => openCard(kit, c.id, load) }, 'Բացել'), h('button.btn.sm', { type: 'button', disabled: c.status !== 'active', title: c.status === 'active' ? 'A4, դիմաց + հետև (CVV)' : 'Ապաակտիվ քարտը հնարավոր չէ տպել', onclick: () => printOne(kit, c) }, 'Տպել')))))),
      pager(list, d.total, d.pageSize, d.page, (p) => { s.page = p; load(); })));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}

// Print dialog: order, CVV per card (checked on the server against the stored hash), then the one-page A4 PDF.
function printDialog(kit, refreshSel = () => {}, sel = printSel) {
  const { h, api, modal } = kit;
  let url = null, busy = false;
  const rowsBox = h('ol.pq'), gen = h('p.msg', { role: 'alert' }), out = h('div.pq-out', { 'aria-live': 'polite' });
  const inputs = new Map(); // id -> { input, err }
  const go = h('button.btn.p', { type: 'submit' }, 'Պատրաստել PDF');
  // typed codes of older cards: after they match the hash, the server may keep them encrypted (same as issued codes)
  const keepCb = h('input', { type: 'checkbox', checked: true });
  const keepBox = h('label.pq-keep', {}, keepCb, h('span', {}, 'Պահել ստուգված CVV-ները (գաղտնագրված սերվերում), որ հաջորդ անգամ լրացվեն ավտոմատ։ Կոդը չի փոխվում, քարտատերը դուրս չի բերվում համակարգից։'));
  const keep = () => { for (const [id, { input }] of inputs) if (input && sel.has(id)) sel.get(id).cvv = input.value; }; // across a re-render only
  const forget = () => { for (const c of sel.values()) delete c.cvv; for (const { input } of inputs.values()) if (input) input.value = ''; };

  function renderRows() {
    inputs.clear();
    keepBox.hidden = [...sel.values()].every((c) => c.cvvOnFile);
    rowsBox.replaceChildren(...[...sel.values()].map((c, i) => {
      // a card issued with the stored copy gets its CVV on the server; the code is never sent to this page
      const input = c.cvvOnFile ? null : h('input.pq-cvv', { inputmode: 'numeric', maxlength: 3, pattern: '[0-9]{3}', autocomplete: 'off', spellcheck: 'false', 'aria-label': `CVV՝ ${fmtCardNo(c.number)}`, placeholder: '•••', value: c.cvv || '' });
      if (input) input.oninput = () => { input.value = input.value.replace(/\D/g, '').slice(0, 3); };
      const err = h('div.err', { role: 'alert' });
      inputs.set(c.id, { input, err });
      return h('li', {},
        h('span.pq-slot', { 'aria-hidden': 'true' }, String(i + 1)),
        h('div.pq-who', {}, h('span.mono', {}, fmtCardNo(c.number)), h('span', {}, holderName(c) || 'Անանուն')),
        input ? h('label.pq-l', {}, h('span', {}, 'CVV'), input) : h('span.pq-auto', { title: 'CVV-ն կլրացվի ավտոմատ՝ համակարգում պահված գաղտնագրված պատճենից' }, '✓ CVV՝ ավտոմատ'),
        h('button.btn.sm', { type: 'button', 'aria-label': `Հանել ${fmtCardNo(c.number)}`, onclick: () => { keep(); sel.delete(c.id); refreshSel(''); clearOut(); if (!sel.size) close(); else renderRows(); } }, 'Հանել'),
        err);
    }));
  }
  // a tab opened from «Բացել և տպել» may still be loading the Blob: release it a minute later
  const clearOut = () => { if (url) { const u = url; setTimeout(() => URL.revokeObjectURL(u), 60_000); url = null; } out.replaceChildren(); };
  const showFields = (fields = {}) => {
    for (const [id, { input, err }] of inputs) {
      const m = fields[`cvv.${id}`] || fields[`card.${id}`] || '';
      err.textContent = m; err.classList.toggle('on', !!m);
      if (!input) continue;
      if (m) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  };

  const form = h('form', { style: 'padding:0;border:0;background:none', novalidate: true, onsubmit: async (e) => {
    e.preventDefault();
    if (busy) return;
    clearOut(); gen.className = 'msg'; gen.textContent = '';
    const cards = [...sel.values()].map((c) => (c.cvvOnFile ? { id: c.id } : { id: c.id, cvv: inputs.get(c.id).input.value }));
    const fields = {};
    if (!cards.length || cards.length > PRINT_MAX) { gen.className = 'msg err'; gen.textContent = `Ընտրեք 1-ից ${PRINT_MAX} քարտ։`; return; }
    for (const c of cards) if ('cvv' in c && !/^\d{3}$/.test(c.cvv)) fields[`cvv.${c.id}`] = 'Մուտքագրեք 3 նիշանոց CVV կոդը։';
    showFields(fields);
    if (Object.keys(fields).length) { gen.className = 'msg err'; gen.textContent = 'Լրացրեք նշված քարտերի CVV կոդերը։'; inputs.get(Number(Object.keys(fields)[0].slice(4)))?.input.focus(); return; }
    busy = true; go.disabled = true; form.setAttribute('aria-busy', 'true');
    out.replaceChildren(h('p.pq-wait', {}, h('span.spin', { 'aria-hidden': 'true' }), 'Ստուգվում են CVV-ները և պատրաստվում է PDF-ը…'));
    try {
      const typed = cards.filter((c) => 'cvv' in c).map((c) => c.id);
      const r = await api('/pioneer/cards/print-sheet', { method: 'POST', body: { cards, ...(typed.length && { keepEntered: keepCb.checked }) } });
      url = URL.createObjectURL(r.blob);
      const kept = Number(r.headers?.get('x-pioneer-cvv-kept') || 0);
      if (kept && kept === typed.length) { for (const id of typed) { const c = sel.get(id); if (c) { c.cvvOnFile = true; delete c.cvv; } } renderRows(); }
      out.replaceChildren(
        h('p.msg', {}, `PDF-ը պատրաստ է՝ ${cards.length} քարտ, 1 էջ (A4, միակողմանի)։ Բացեք այն և տպեք, կամ ներբեռնեք։` + (kept ? ` ${kept} քարտի CVV-ն պահվեց․ հաջորդ անգամ այն կլրացվի ավտոմատ։` : '')),
        h('div.macts', {}, h('a.btn.p', { href: url, target: '_blank', rel: 'noopener' }, 'Բացել և տպել'), h('a.btn', { href: url, download: r.filename }, 'Ներբեռնել PDF')));
    } catch (x) {
      out.replaceChildren();
      if (x.message === 'auth') return;
      // a stored copy that no longer opens (e.g. the pepper was changed): ask for that code instead
      if (x.code === 'cvv_unavailable') {
        let n = 0;
        for (const c of sel.values()) if (c.cvvOnFile && x.fields?.[`cvv.${c.id}`]) { c.cvvOnFile = false; n++; }
        if (n) { keep(); renderRows(); }
      }
      showFields(x.fields);
      gen.className = 'msg err'; gen.textContent = x.fields?.cards || x.message;
    } finally { busy = false; go.disabled = false; form.removeAttribute('aria-busy'); }
  } },
  h('p.help', { style: 'margin:0 0 12px' }, `Թերթը՝ մեկ A4 էջ (միակողմանի)․ յուրաքանչյուր քարտի դիմացը՝ իր CVV-ով։ Քարտերը տպվում են այս հերթականությամբ (2 սյուն × 4 տող), դատարկ դիրքերը մնում են դատարկ։ «CVV՝ ավտոմատ» նշված քարտերի կոդը սերվերը վերցնում է ինքը (այն այս էջ չի ուղարկվում)։ Ավելի վաղ ստեղծված քարտերի CVV-ն պահված է միայն հեշի տեսքով և հնարավոր չէ վերականգնել․ դրանց համար մուտքագրեք կոդը մեկ անգամ (ստորև նշված տարբերակով այն կպահվի), կամ վերականգնեք CVV-ն քարտի էջում (նոր կոդ, քարտատերը դուրս կբերվի)։ Ամեն կոդ ստուգվում է քարտի հեշով, և սխալ կոդով ոչինչ չի տպվի։`),
  rowsBox, keepBox,
  h('ul.pq-tips', {},
    h('li', {}, 'Թուղթ՝ A4։ Մասշտաբ՝ «Actual size» / 100%, ոչ «Fit to page»։'),
    h('li', {}, 'Միակողմանի (one-sided)՝ մեկ A4 էջ, միայն դիմային կողմերը՝ յուրաքանչյուրն իր CVV-ով։'),
    h('li', {}, 'Կտրեք կտրման նշաններով։')),
  gen, h('div.macts', { style: 'margin-top:12px' }, go), out);

  renderRows();
  const close = modal(sel === printSel ? `Տպել ընտրված քարտերը (${sel.size})` : 'Տպել քարտը (A4)', form);
  // closing the dialog (button, Esc, backdrop) wipes the typed codes and the in-memory PDF
  const obs = new MutationObserver(() => { if (!form.isConnected) { obs.disconnect(); forget(); clearOut(); } });
  obs.observe(document.body, { childList: true, subtree: true });
}

// Bulk "delete": preview from the server (counts of everything tied to the cards), then a second explicit
// confirmation. Permanent deletion is blocked by the server (it would destroy financial history); the safe,
// reversible alternative is to retire the cards (= deactivate).
async function bulkDialog(kit, target, done) {
  const { h, api, modal } = kit;
  const holder = h('div', {}, h('p.pq-wait', {}, h('span.spin', { 'aria-hidden': 'true' }), 'Հաշվարկվում են կապված գրառումները…'));
  const close = modal(target.all ? 'Ջնջել բոլոր քարտերը' : `Ջնջել ընտրված քարտերը (${target.ids.length})`, holder);
  let p;
  try { p = await api('/pioneer/cards/bulk-preview', { method: 'POST', body: target }); }
  catch (e) { if (e.message !== 'auth') holder.replaceChildren(h('p.msg.err', { role: 'alert' }, errText(e))); return; }
  const H = p.history, R = H.redemptions, n = p.cards.selected;
  const row = (label, v) => [h('dt', {}, label), h('dd', {}, v)];
  const blocked = Object.entries({ 'գործարք (ledger, անփոփոխելի)': p.permanentDelete.blockedBy.transactions, 'փոխանցում': p.permanentDelete.blockedBy.transfers, 'պարգևի հայտ': p.permanentDelete.blockedBy.redemptions, 'ակտիվության գրառում': p.permanentDelete.blockedBy.auditEntries })
    .filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ');
  const ack = h('input', { type: 'checkbox' }), typed = h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: String(n), 'aria-label': `Մուտքագրեք ${n}` });
  const go = h('button.btn.danger', { type: 'button', disabled: true }, `Ապաակտիվացնել ${p.retire.willDeactivate} քարտ`);
  const msg = h('p.msg', { role: 'alert' });
  const sync = () => { go.disabled = !(ack.checked && typed.value.trim() === String(n) && p.retire.willDeactivate > 0); };
  ack.onchange = sync; typed.oninput = sync;
  go.onclick = async () => {
    go.disabled = true; msg.className = 'msg'; msg.textContent = 'Կատարվում է…';
    try {
      const { result: r } = await api('/pioneer/cards/bulk-retire', { method: 'POST', body: { ...target, token: p.token, confirmCount: n } });
      holder.replaceChildren(
        h('p.msg', {}, `Պատրաստ է․ ապաակտիվացվեց ${r.retired} քարտ${r.alreadyInactive ? `, ${r.alreadyInactive}-ն արդեն ապաակտիվ էր` : ''}, փակվեց ${r.sessionsEnded} սեսիա։ Ոչ մի գրառում չի ջնջվել․ քարտերը կարելի է կրկին ակտիվացնել քարտի էջից։`),
        h('div.macts', { style: 'margin-top:14px' }, h('button.btn.p', { type: 'button', onclick: () => close() }, 'Փակել')));
      done();
    } catch (e) { if (e.message === 'auth') return; msg.className = 'msg err'; msg.textContent = errText(e); sync(); }
  };
  holder.replaceChildren(
    h('div.bulk-warn', { role: 'alert' },
      h('b', {}, 'Վերջնական ջնջումը արգելափակված է։'),
      h('p', {}, blocked
        ? `Այս քարտերին կապված են ${blocked}։ Դրանք ֆինանսական պատմություն և աուդիտ են${H.transfersWithOtherCards ? ` (այդ թվում ${H.transfersWithOtherCards} փոխանցում չընտրված քարտերի հետ)` : ''}, և ջնջելը կվնասեր հաշվետվողականությունը։ Փոխարենը քարտերը կարելի է ապաակտիվացնել (retire)՝ անվտանգ և հետադարձելի։`
        : 'Այս գործիքը քարտեր չի ջնջում ընդմիշտ։ Փոխարենը քարտերը կարելի է ապաակտիվացնել (retire)՝ անվտանգ և հետադարձելի։')),
    h('dl.kv', {},
      row('Ընտրված քարտեր', `${n}${p.scope === 'all' ? ' (բոլորը)' : ''}`),
      row('Ակտիվ / արդեն ապաակտիվ', `${p.cards.active} / ${p.cards.alreadyInactive}`),
      row('Մնացորդ ունեցող քարտեր', p.cards.withBalance ? `${p.cards.withBalance} (ընդամենը ${num(p.cards.balanceTotal)} միավոր)` : 'չկան'),
      row('Գործարքներ', num(H.transactions)),
      row('Փոխանցումներ', `${num(H.transfers)}${H.transfersWithOtherCards ? ` (${H.transfersWithOtherCards}-ը՝ չընտրված քարտերի հետ)` : ''}`),
      row('Այլ քարտերի պատմության հղումներ', num(H.otherCardsHistoryRefs)),
      row('Պարգևների հայտեր', `սպասող ${R.pending}, հաստատված ${R.approved}, տրամադրված ${R.fulfilled}, չեղարկված ${R.cancelled}`),
      row('Թողարկված նվերի կոդեր', num(H.giftCodes)),
      row('Ակտիվության գրառումներ', num(H.auditEntries)),
      row('Ակտիվ սեսիաներ', num(p.activeSessions))),
    h('div.sec', {}, h('h3', {}, 'Ինչ տեղի կունենա'),
      h('ul.pq-tips', {},
        h('li', {}, `${p.retire.willDeactivate} ակտիվ քարտ կդառնա «Ապաակտիվ»․ քարտատերերը դուրս կբերվեն (${p.retire.willEndSessions} սեսիա) և չեն կարողանա մուտք գործել, փոխանցել կամ օգտագործել միավորներ։`),
        h('li', {}, 'Կպահպանվեն անփոփոխ՝ մնացորդները, բոլոր գործարքները, փոխանցումները (երկու կողմերի համար), հայտերը, նվերի կոդերը, ակտիվության մատյանը, քարտի համարը և CVV-ի հեշը։'),
        h('li', {}, 'Չընտրված քարտերի պատմությունը չի փոխվում։ Սպասող և հաստատված հայտերը մնում են՝ ադմինը կարող է դրանք մշակել։'),
        h('li', {}, 'Գործողությունը հետադարձելի է՝ քարտի էջում «Ակտիվացնել»։'))),
    p.retire.willDeactivate
      ? h('div.sec', {}, h('h3', {}, 'Հաստատում'),
        h('label.pq-keep', {}, ack, h('span', {}, `Հասկանում եմ, որ ${p.retire.willDeactivate} քարտ կապաակտիվացվի, և քարտատերերը կկորցնեն մուտքը։`)),
        h('label', { style: 'display:block;font-size:13px;color:var(--mut);margin:0 0 6px' }, `Լրացրեք ընտրված քարտերի թիվը (${n})՝ հաստատելու համար`), typed,
        msg, h('div.macts', { style: 'margin-top:14px' }, go, h('button.btn', { type: 'button', onclick: () => close() }, 'Չեղարկել')))
      : h('div', {}, h('p.msg', {}, 'Բոլոր ընտրված քարտերն արդեն ապաակտիվ են․ փոփոխելու բան չկա։'), h('div.macts', { style: 'margin-top:14px' }, h('button.btn', { type: 'button', onclick: () => close() }, 'Փակել'))));
}

function holderForm(kit, card, onSubmit, submitLabel) {
  const { h } = kit;
  const { field, show } = fieldsKit(h);
  const fn = h('input', { maxlength: 50, value: card.firstName || '', autocomplete: 'off' });
  const ln = h('input', { maxlength: 50, value: card.lastName || '', autocomplete: 'off' });
  const ph = h('input', { type: 'tel', maxlength: 25, value: card.phone || '', placeholder: '+374 00 000000', autocomplete: 'off' });
  const note = h('p.msg'), go = h('button.btn.p', { type: 'submit' }, submitLabel);
  const form = h('form', { style: 'padding:0;border:0;background:none', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; note.className = 'msg'; note.textContent = ''; show();
    try { await onSubmit({ firstName: fn.value, lastName: ln.value, phone: ph.value }); }
    catch (x) { if (x.message === 'auth') return; show(x.fields); note.className = 'msg err'; note.textContent = x.fields ? '' : x.message; }
    finally { go.disabled = false; }
  } }, h('div.frm', {}, field('Անուն (կամընտիր)', fn, 'firstName'), field('Ազգանուն (կամընտիր)', ln, 'lastName'),
    field('Հեռախոս (կամընտիր, տեսանելի է միայն ադմինիստրատորներին)', ph, 'phone', { full: true })), note, h('div.macts', { style: 'margin-top:14px' }, go));
  return form;
}

function createCard(kit, reload) {
  const { h, api, modal } = kit;
  const holder = h('div');
  const form = holderForm(kit, {}, async (v) => {
    const d = await api('/pioneer/cards', { method: 'POST', body: v });
    reload();
    showIssued(kit, holder, d.card, d.cvv, 'Քարտը ստեղծված է');
  }, 'Ստեղծել քարտ');
  holder.append(h('p.help', { style: 'margin:0 0 14px' }, 'Քարտի համարը և CVV-ն գեներացվում են ավտոմատ։ Բոլոր դաշտերը կամընտիր են․ անունը կարող եք ավելացնել հետո կամ գրել ձեռքով տպված քարտի վրա։ Քարտը ստանում է մեկնարկային բոնուս։'), form);
  modal('Նոր Pioneer Card', holder);
}

function showIssued(kit, holder, card, cvv, heading) {
  const { h } = kit;
  holder.replaceChildren(
    h('p', { style: 'margin:0 0 14px;color:#86efac' }, heading + '։'),
    cardPreview(kit, card),
    h('div.cvv-box', {}, h('div', {}, h('span.muted', { style: 'font-size:12px;display:block' }, 'CVV կոդ'), h('b', {}, cvv)),
      h('p', {}, 'Այս կոդը ցուցադրվում է միայն հիմա և այլևս հնարավոր չի լինի տեսնել (համակարգում պահվում է միայն հեշը)։ Փոխանցեք այն քարտատիրոջը առանձին (օր.՝ փակ ծրարով) կամ տպեք քարտի հետևի կողմում՝ «Ավելացնել տպման ընտրությանը» (կոդը կմնա միայն այս էջի հիշողության մեջ, մինչև տպման պատուհանը փակելը)։ Կորցնելու դեպքում օգտագործեք «Վերականգնել CVV»։')),
    h('dl.kv', {}, h('dt', {}, 'Քարտի №'), h('dd', {}, h('span.mono', {}, fmtCardNo(card.number))), h('dt', {}, 'Քարտատեր'), h('dd', {}, holderName(card) || 'Անանուն (դատարկ դաշտ՝ ձեռքով լրացնելու համար)'), h('dt', {}, 'Միավորներ'), h('dd', {}, num(card.balance))),
    h('div.macts', {}, h('button.btn.p', { type: 'button', onclick: () => printOne(kit, card, cvv) }, 'Տպել քարտը (A4, PDF)'),
      card.status === 'active' ? h('button.btn', { type: 'button', onclick: (e) => {
        const was = printSel.has(card.id), ok = selCard(card, card.cvvOnFile ? undefined : cvv); // a stored code is not kept in the page
        onPrintSel(ok ? (was ? `Քարտ ${fmtCardNo(card.number)}-ի CVV-ն ավելացված է ընտրությանը։` : `Քարտ ${fmtCardNo(card.number)}-ն ավելացված է տպման ընտրությանը։`) : `Ընտրությունը լրացված է (${PRINT_MAX} քարտ)։`, !ok);
        e.target.textContent = ok ? 'Ավելացված է ընտրությանը ✓' : `Ընտրությունը լրացված է (${PRINT_MAX})`; e.target.disabled = true;
      } }, 'Ավելացնել տպման ընտրությանը') : null));
}

async function openCard(kit, id, reloadList) {
  const { h, api, modal, when, pager } = kit;
  const holder = h('div', {}, h('p.muted', {}, 'Բեռնվում է…'));
  modal('Pioneer Card', holder);
  let txPage = 1;
  async function render(flash) {
    let d;
    try { d = await api(`/pioneer/cards/${id}`); } catch (e) { if (e.message !== 'auth') holder.replaceChildren(errBox(h, e)); return; }
    const c = d.card, L = d.login;
    const note = h('p.msg'); if (flash) note.textContent = flash;
    const txBox = h('div');
    const act = async (fn, okText) => { note.className = 'msg'; note.textContent = ''; try { await fn(); reloadList(); await render(okText); } catch (e) { if (e.message !== 'auth') { note.className = 'msg err'; note.textContent = e.message; } } };
    const lock = L.hardLocked ? h('span.neg', {}, `Արգելափակված է (${L.failures} անհաջող փորձ)`) : L.locked ? h('span.warn', {}, `Ժամանակավոր արգելափակում մինչև ${when(L.lockedUntil)}`) : L.failures ? `${L.failures} անհաջող փորձ` : 'Նորմալ';
    holder.replaceChildren(
      cardPreview(kit, c),
      h('dl.kv', {},
        h('dt', {}, 'Քարտի №'), h('dd', {}, h('span.mono', {}, fmtCardNo(c.number))),
        h('dt', {}, 'Քարտատեր'), h('dd', {}, holderName(c) || h('span.muted', {}, 'Անանուն (ցուցադրվում է որպես «Pioneer Member»)')),
        h('dt', {}, 'Հեռախոս'), h('dd', {}, c.phone || '—'),
        h('dt', {}, 'Մնացորդ'), h('dd', {}, h('b', {}, num(c.balance) + ' միավոր')),
        h('dt', {}, 'Կարգավիճակ'), h('dd', {}, h('span.st.' + c.status, {}, CARD_ST[c.status])),
        h('dt', {}, 'Ստեղծվել է'), h('dd', {}, when(c.createdAt)),
        h('dt', {}, 'Առաջին մուտք'), h('dd', {}, c.activatedAt ? when(c.activatedAt) : 'Դեռ չի եղել'),
        h('dt', {}, 'Վերջին մուտք'), h('dd', {}, c.lastLoginAt ? when(c.lastLoginAt) : '—'),
        h('dt', {}, 'Մուտքի պաշտպանություն'), h('dd', {}, lock, L.failures ? h('button.btn.sm', { type: 'button', style: 'margin-left:10px', onclick: () => act(() => api(`/pioneer/cards/${id}/unlock`, { method: 'POST', body: {} }), 'Ապակողպված է։') }, 'Ապակողպել') : null),
        h('dt', {}, 'CVV'), h('dd', {}, c.cvvResetAt ? `Վերականգնվել է ${when(c.cvvResetAt)}` : 'Սկզբնական (պահպանված է միայն հեշի տեսքով)')),
      h('div.macts', {},
        h('button.btn.sm', { type: 'button', onclick: () => editHolder(kit, c, () => render('Տվյալները պահպանված են։').then(reloadList)) }, 'Խմբագրել անունը/հեռախոսը'),
        h('button.btn.sm', { type: 'button', onclick: () => adjustPoints(kit, c, () => render('Միավորները ճշգրտված են։').then(reloadList)) }, 'Ճշգրտել միավորները'),
        h('button.btn.sm', { type: 'button', onclick: async () => {
          const to = c.status === 'active' ? 'inactive' : 'active';
          if (await confirmBox(kit, to === 'inactive' ? 'Ապաակտիվացնե՞լ քարտը' : 'Ակտիվացնե՞լ քարտը', to === 'inactive' ? 'Քարտատերը դուրս կբերվի համակարգից և չի կարողանա մուտք գործել, փոխանցել կամ օգտագործել միավորներ, մինչև քարտը կրկին ակտիվացվի։ Միավորները կպահպանվեն։' : 'Քարտը կրկին հասանելի կլինի մուտքի և գործարքների համար։', to === 'inactive' ? 'Ապաակտիվացնել' : 'Ակտիվացնել', { danger: to === 'inactive' }))
            act(() => api(`/pioneer/cards/${id}/status`, { method: 'POST', body: { status: to } }), to === 'inactive' ? 'Քարտը ապաակտիվացված է։' : 'Քարտը ակտիվացված է։');
        } }, c.status === 'active' ? 'Ապաակտիվացնել' : 'Ակտիվացնել'),
        h('button.btn.sm', { type: 'button', onclick: async () => {
          if (!(await confirmBox(kit, 'Վերականգնե՞լ CVV-ն', 'Կգեներացվի նոր CVV կոդ, հինը կդադարի գործել, և քարտի բոլոր ակտիվ սեսիաները կփակվեն։ Նոր կոդը կցուցադրվի միայն մեկ անգամ։', 'Գեներացնել նոր CVV', { danger: true }))) return;
          try { const r = await api(`/pioneer/cards/${id}/cvv`, { method: 'POST', body: {} }); showIssued(kit, holder, c, r.cvv, 'Նոր CVV-ն գեներացված է'); reloadList(); }
          catch (e) { if (e.message !== 'auth') { note.className = 'msg err'; note.textContent = e.message; } }
        } }, 'Վերականգնել CVV'),
        h('button.btn.sm', { type: 'button', disabled: c.status !== 'active', title: c.status === 'active' ? 'A4, դիմաց + հետև (CVV)' : 'Ապաակտիվ քարտը հնարավոր չէ տպել', onclick: () => printOne(kit, c) }, 'Տպել (A4, PDF)')),
      note,
      h('div.sec', {}, h('h3', {}, 'Գործարքներ'), txBox),
      h('div.sec', {}, h('h3', {}, 'Պարգևների հայտեր'), d.redemptions.length ? h('div.tbl.sm', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Հղում', 'Պարգև', 'Միավոր', 'Կարգավիճակ', 'Ամսաթիվ'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.redemptions.map((r) => h('tr', {}, h('td', {}, h('span.mono', {}, r.reference)), h('td', {}, r.rewardTitle), h('td', {}, num(r.points)), h('td', {}, h('span.st.' + r.status, {}, RED_ST[r.status]), giftLine(h, r)), h('td', {}, when(r.createdAt)))))))
        : h('p.muted', { style: 'font-size:14px' }, 'Հայտեր չկան։')));
    const loadTx = async () => {
      try {
        const t = await api(`/pioneer/cards/${id}/transactions?page=${txPage}&pageSize=15`);
        txBox.replaceChildren(h('div.tbl.sm', {}, h('table', {},
          h('thead', {}, h('tr', {}, ['Ամսաթիվ', 'Տեսակ', 'Միավոր', 'Մնացորդ', 'Մանրամասներ'].map((x) => h('th', {}, x)))),
          h('tbody', {}, t.items.map((x) => h('tr', {}, h('td', {}, when(x.createdAt)), h('td', {}, TX_LABELS[x.type]), h('td', {}, h('b.' + (x.amount > 0 ? 'pos' : 'neg'), {}, signed(x.amount))), h('td', {}, num(x.balanceAfter)),
            h('td', { style: 'white-space:normal;min-width:200px' }, [x.counterparty ? `${x.type === 'transfer_out' ? '→' : '←'} ${x.counterparty.name} (${fmtCardNo(x.counterparty.number)})` : '', x.description, x.reference, x.admin ? `ադմին՝ ${x.admin}` : ''].filter(Boolean).join(' · '))))))),
        pager(txBox, t.total, t.pageSize, t.page, (p) => { txPage = p; loadTx(); }));
      } catch (e) { if (e.message !== 'auth') txBox.replaceChildren(errBox(h, e)); }
    };
    await loadTx();
  }
  await render();
}

function editHolder(kit, card, done) {
  const { h, api, modal } = kit;
  let close;
  const form = holderForm(kit, card, async (v) => { await api(`/pioneer/cards/${card.id}`, { method: 'PATCH', body: v }); close(); done(); }, 'Պահպանել');
  close = modal(`Քարտ ${fmtCardNo(card.number)}`, h('div', {}, h('p.help', { style: 'margin:0 0 14px' }, 'Դատարկ թողնված անունով քարտը մնում է վավեր և ցուցադրվում է որպես «Pioneer Member»։'), form), { small: true });
}

function adjustPoints(kit, card, done) {
  const { h, api, modal } = kit;
  const { field, show } = fieldsKit(h);
  const amt = h('input', { inputmode: 'numeric', maxlength: 8, placeholder: 'օր.՝ 50 կամ -20', autocomplete: 'off' });
  const reason = h('textarea', { maxlength: 300, rows: 3, placeholder: 'Պարտադիր․ օր.՝ «Հաքաթոնի հաղթող» կամ «Սխալ հաշվարկի ուղղում»' });
  const note = h('p.msg'), go = h('button.btn.p', { type: 'submit' }, 'Գրանցել ճշգրտումը');
  let close;
  const form = h('form', { style: 'padding:0;border:0;background:none', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); show(); note.textContent = '';
    const n = Number(amt.value.trim());
    if (!Number.isInteger(n) || n === 0) return show({ amount: 'Մուտքագրեք ոչ զրոյական ամբողջ թիվ։' });
    if (reason.value.trim().length < 3) return show({ reason: 'Նշեք պատճառը։' });
    if (!(await confirmBox(kit, 'Հաստատե՞լ ճշգրտումը', `${signed(n)} միավոր քարտ ${fmtCardNo(card.number)}-ին։ Նոր մնացորդը՝ ${num(card.balance + n)}։ Գործարքը կգրանցվի ձեր անունով և չի կարող ջնջվել։`))) return;
    go.disabled = true;
    try { await api(`/pioneer/cards/${card.id}/adjust`, { method: 'POST', body: { amount: n, reason: reason.value } }); close(); done(); }
    catch (x) { if (x.message === 'auth') return; show(x.fields); note.className = 'msg err'; note.textContent = x.message; }
    finally { go.disabled = false; }
  } }, h('p.help', { style: 'margin:0 0 6px' }, `Ընթացիկ մնացորդը՝ ${num(card.balance)}։ Դրական թիվը ավելացնում է, բացասականը՝ նվազեցնում։`),
  field('Միավորներ (+/−)', amt, 'amount'), field('Պատճառ', reason, 'reason'), note, h('div.macts', { style: 'margin-top:14px' }, go));
  close = modal('Միավորների ճշգրտում', form, { small: true });
}

// ---------- rewards & courses ---------------------------------------------------------------
async function viewRewards(box, kit) {
  const { h, api } = kit;
  const list = h('div');
  let showArchived = false;
  const toggle = h('button.btn.sm', { type: 'button', onclick: () => { showArchived = !showArchived; toggle.textContent = showArchived ? 'Ցույց տալ ակտիվները' : 'Ցույց տալ արխիվը'; load(); } }, 'Ցույց տալ արխիվը');
  box.append(h('div.tools', {}, h('button.btn.sm.p', { type: 'button', onclick: () => rewardForm(kit, null, load) }, '+ Նոր դասընթաց / պարգև'), toggle,
    h('span.count', {}, 'Միավորների քանակը և զեղչերը որոշում է ադմինիստրատորը։')), list);
  async function load() {
    try {
      const d = await api('/pioneer/rewards' + (showArchived ? '?status=archived' : ''));
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, showArchived ? 'Արխիվը դատարկ է։' : 'Դեռ դասընթացներ կամ պարգևներ չկան։ Քարտատերերը կտեսնեն «շուտով» էջ, մինչև դուք հրապարակեք առաջինը։')));
      const setStatus = async (r, status) => { try { await api(`/pioneer/rewards/${r.id}`, { method: 'PATCH', body: { status } }); load(); } catch (e) { if (e.message !== 'auth') alert(e.message); } };
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Անվանում', 'Տեսակ', 'Միավոր', 'Առավելություն', 'Հասանելիություն', 'Օգտագործված', 'Կարգավիճակ', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((r) => {
          const ic = h('span', { style: 'color:var(--pri2)' }); ic.innerHTML = icon(r.icon);
          return h('tr', {}, h('td', {}, ic), h('td', { style: 'white-space:normal;min-width:160px' }, h('b', {}, r.title)), h('td', {}, KIND[r.kind]), h('td', {}, h('b', {}, num(r.pointsCost))),
            h('td', {}, [r.discountPercent ? `${r.discountPercent}%` : '', r.discountAmount ? `${num(r.discountAmount)} ֏` : ''].filter(Boolean).join(' / ') || '—'),
            h('td', { style: 'white-space:normal;min-width:140px;font-size:13px' }, [r.availableFrom ? `սկսած ${kit.when(r.availableFrom)}` : '', r.availableUntil ? `մինչև ${kit.when(r.availableUntil)}` : '', r.availabilityNote].filter(Boolean).join(' · ') || 'Անժամկետ'),
            h('td', {}, `${r.redeemedCount}${r.maxRedemptions ? ' / ' + r.maxRedemptions : ''}`),
            h('td', {}, h('span.st.' + r.status, {}, RW_ST[r.status])),
            h('td.act', {}, h('button.btn.sm', { type: 'button', onclick: () => rewardForm(kit, r, load) }, 'Խմբագրել'),
              r.status === 'published' ? h('button.btn.sm', { type: 'button', onclick: () => setStatus(r, 'draft') }, 'Հանել հրապարակումից') : h('button.btn.sm.p', { type: 'button', onclick: () => setStatus(r, 'published') }, 'Հրապարակել'),
              r.status !== 'archived' ? h('button.btn.sm', { type: 'button', onclick: async () => { if (await confirmBox(kit, 'Արխիվացնե՞լ', `«${r.title}»-ը այլևս չի ցուցադրվի քարտատերերին։ Եղած հայտերը կպահպանվեն։`, 'Արխիվացնել')) setStatus(r, 'archived'); } }, 'Արխիվ') : null,
              r.redeemedCount === 0 ? h('button.btn.sm', { type: 'button', onclick: async () => {
                if (!(await confirmBox(kit, 'Ջնջե՞լ', `«${r.title}»-ը կջնջվի ընդմիշտ։ Հնարավոր է միայն այն պարգևների համար, որոնք երբեք չեն օգտագործվել։`, 'Ջնջել', { danger: true }))) return;
                try { await api(`/pioneer/rewards/${r.id}`, { method: 'DELETE' }); load(); } catch (e) { if (e.message !== 'auth') alert(e.message); }
              } }, 'Ջնջել') : null));
        })))));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}

function rewardForm(kit, r, reload) {
  const { h, api, modal } = kit;
  const { field, show } = fieldsKit(h);
  r = r || {};
  const opt = (map, cur) => Object.entries(map).map(([k, v]) => h('option', { value: k, selected: cur === k }, v));
  const kind = h('select', {}, opt(KIND, r.kind || 'course_discount'));
  const title = h('input', { maxlength: 120, value: r.title || '', placeholder: 'օր.՝ Վեբ ծրագրավորում' });
  const desc = h('textarea', { maxlength: 2000, rows: 4 }, r.description || '');
  const ic = h('select', {}, ICON_KEYS.map((k) => h('option', { value: k, selected: (r.icon || 'spark') === k }, ICON_LBL[k])));
  const n = (v, ph) => h('input', { inputmode: 'numeric', maxlength: 9, value: v ?? '', placeholder: ph || '' });
  const cost = n(r.pointsCost, 'օր.՝ 500'), pct = n(r.discountPercent, '1–100'), amt = n(r.discountAmount, 'դրամ'), max = n(r.maxRedemptions, 'անսահմանափակ'), per = n(r.perCardLimit, 'անսահմանափակ'), sort = n(r.sortOrder ?? 0);
  const from = h('input', { type: 'datetime-local', value: toLocalInput(r.availableFrom) }), until = h('input', { type: 'datetime-local', value: toLocalInput(r.availableUntil) });
  const avail = h('input', { maxlength: 200, value: r.availabilityNote || '', placeholder: 'օր.՝ Գործում է 2026 թ. աշնանային հոսքի համար' });
  const status = h('select', {}, opt(RW_ST, r.status || 'draft'));
  const note = h('p.msg'), go = h('button.btn.p', { type: 'submit' }, r.id ? 'Պահպանել' : 'Ստեղծել');
  let close;
  const form = h('form', { style: 'padding:0;border:0;background:none', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; show(); note.className = 'msg'; note.textContent = '';
    const body = { kind: kind.value, title: title.value, description: desc.value, icon: ic.value, pointsCost: cost.value.trim(), discountPercent: pct.value.trim() || null, discountAmount: amt.value.trim() || null,
      maxRedemptions: max.value.trim() || null, perCardLimit: per.value.trim() || null, sortOrder: sort.value.trim() || 0, availableFrom: fromLocalInput(from.value), availableUntil: fromLocalInput(until.value), availabilityNote: avail.value, status: status.value };
    try { await api(r.id ? `/pioneer/rewards/${r.id}` : '/pioneer/rewards', { method: r.id ? 'PATCH' : 'POST', body }); close(); reload(); }
    catch (x) { if (x.message === 'auth') return; show(x.fields); note.className = 'msg err'; note.textContent = x.message; }
    finally { go.disabled = false; }
  } }, h('div.frm', {},
    field('Տեսակ', kind, 'kind'), field('Պատկերակ', ic, 'icon'),
    field('Անվանում', title, 'title', { full: true }), field('Նկարագրություն', desc, 'description', { full: true }),
    field('Պահանջվող միավորներ', cost, 'pointsCost'), field('Կարգավիճակ', status, 'status'),
    field('Զեղչ, % (կամընտիր)', pct, 'discountPercent'), field('Զեղչ, ֏ (կամընտիր)', amt, 'discountAmount'),
    field('Հասանելի է սկսած (կամընտիր)', from, 'availableFrom', { help: 'Մինչ այդ ցուցադրվում է որպես «շուտով»՝ փակված։' }), field('Հասանելի է մինչև (կամընտիր)', until, 'availableUntil'),
    field('Հասանելիության նշում (կամընտիր)', avail, 'availabilityNote', { full: true }),
    field('Ընդհանուր սահմանաչափ (կամընտիր)', max, 'maxRedemptions'), field('Մեկ քարտին (կամընտիր)', per, 'perCardLimit'),
    field('Դասավորության կարգ', sort, 'sortOrder')),
  h('p.help', {}, 'Զեղչը չի կիրառվում ավտոմատ որևէ վճարման համակարգում․ ստեղծվում է հայտ, որը աշխատակիցը ստուգում և կատարում է «Հայտեր» բաժնում։'), note, h('div.macts', { style: 'margin-top:14px' }, go));
  close = modal(r.id ? `Խմբագրել՝ ${r.title}` : 'Նոր դասընթաց / պարգև', form);
}

// ---------- redemptions -------------------------------------------------------------------
// Gift code of an approved / handed-over request (admins only; the cardholder sees it on their gift card).
const giftLine = (h, r) => (r.giftCard ? h('div', { style: 'font-size:12px;margin-top:4px' }, 'Նվերի կոդ՝ ', h('span.mono', {}, r.giftCard.code)) : null);
const byLine = (h, r) => {
  const t = [r.approvedBy && `հաստատել է՝ ${r.approvedBy}`, r.handledBy && r.status !== 'approved' && `${r.status === 'cancelled' ? 'չեղարկել' : 'տրամադրել'} է՝ ${r.handledBy}`].filter(Boolean).join(' · ');
  return t ? h('div.muted', { style: 'font-size:12px' }, t) : null;
};
async function viewRedemptions(box, kit) {
  const { h, api, pager, debounce, when } = kit;
  const s = ui.red;
  const list = h('div'), count = h('span.count');
  const search = h('input', { type: 'search', placeholder: 'Քարտի համար, հայտի հղում (RD-…) կամ նվերի կոդ (MG-…)', 'aria-label': 'Որոնում', value: s.q, maxlength: 30, oninput: debounce((e) => { s.q = e.target.value.replace(/\s/g, ''); s.page = 1; load(); }) });
  const sel = h('select', { 'aria-label': 'Կարգավիճակ', onchange: (e) => { s.status = e.target.value; s.page = 1; load(); } }, h('option', { value: '' }, 'Բոլորը'), Object.entries(RED_ST).map(([k, v]) => h('option', { value: k, selected: s.status === k }, v)));
  // A server that predates gift cards rejects status "approved" with a field error; detect it up front (its stats lack approvedRedemptions).
  const canApprove = await api('/pioneer/stats').then((d) => 'approvedRedemptions' in d, () => true);
  box.append(canApprove ? '' : h('div.empty', { role: 'alert', style: 'text-align:left;color:#fde68a;border:1px solid rgba(250,204,21,.45);border-radius:12px;margin-bottom:14px;padding:14px 16px' }, OUTDATED_SERVER),
    h('div.tools', {}, search, sel, count), list);
  const handle = async (r, status) => {
    const who = `քարտ ${fmtCardNo(r.card)}-ի տիրոջը (${r.holder})`;
    const C = {
      approved: ['Հաստատե՞լ հայտը', `«${r.rewardTitle}» հայտը կհաստատվի, և ${who} կտրամադրվի նվերի ստացման քարտ՝ եզակի կոդով։ Միավորները կրկին չեն գանձվի։ Նվերը դեռ տրամադրված չի համարվի։`, 'Հաստատել'],
      fulfilled: ['Նշե՞լ որպես տրամադրված', `Հաստատեք, որ «${r.rewardTitle}»-ը փաստացի տրամադրվել է ${who}${r.giftCard ? ` (նվերի կոդ՝ ${r.giftCard.code})` : ''}։`, 'Տրամադրված է'],
      cancelled: ['Չեղարկե՞լ հայտը', `${num(r.points)} միավորը կվերադարձվի քարտ ${fmtCardNo(r.card)}-ին${r.giftCard ? ', և նվերի քարտը կչեղարկվի' : ''}։`, 'Չեղարկել և վերադարձնել'],
    }[status];
    if (!(await confirmBox(kit, C[0], C[1], C[2], { danger: status === 'cancelled' }))) return;
    try { await api(`/pioneer/redemptions/${r.id}/status`, { method: 'POST', body: { status } }); }
    catch (e) {
      if (e.message === 'auth') return;
      const outdated = e.status === 422 && e.fields?.status && status === 'approved';
      errorDialog(kit, 'Գործողությունը չկատարվեց', outdated ? OUTDATED_SERVER : errText(e));
    }
    load(); // the request may have been handled meanwhile (another admin, earlier click): always show the current state
  };
  async function load() {
    try {
      const d = await api('/pioneer/redemptions?' + new URLSearchParams({ q: s.q, status: s.status, page: s.page }));
      s.page = d.page; count.textContent = `Ընդամենը՝ ${d.total}`;
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, 'Հայտեր չեն գտնվել։')));
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Հղում', 'Քարտ', 'Քարտատեր', 'Պարգև', 'Միավոր', 'Կարգավիճակ', 'Ամսաթիվ', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((r) => h('tr', {}, h('td', {}, h('span.mono', {}, r.reference)), h('td', {}, h('span.mono', {}, fmtCardNo(r.card))), h('td', {}, r.holder),
          h('td', { style: 'white-space:normal;min-width:160px' }, r.rewardTitle, r.rewardBenefit ? h('div.muted', { style: 'font-size:12.5px' }, r.rewardBenefit) : null), h('td', {}, num(r.points)),
          h('td', {}, h('span.st.' + r.status, {}, RED_ST[r.status]), giftLine(h, r), byLine(h, r)), h('td', {}, when(r.createdAt)),
          h('td.act', {}, r.status === 'pending' ? [h('button.btn.sm.p', { type: 'button', onclick: () => handle(r, 'approved'), disabled: !canApprove, title: canApprove ? null : 'Սերվերը թարմացված չէ' }, 'Հաստատել'), h('button.btn.sm', { type: 'button', onclick: () => handle(r, 'cancelled') }, 'Չեղարկել')]
            : r.status === 'approved' ? [h('button.btn.sm.p', { type: 'button', onclick: () => handle(r, 'fulfilled') }, 'Տրամադրված է'), h('button.btn.sm', { type: 'button', onclick: () => handle(r, 'cancelled') }, 'Չեղարկել')] : null)))))),
      pager(list, d.total, d.pageSize, d.page, (p) => { s.page = p; load(); }));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}

// ---------- ledger -------------------------------------------------------------------------
async function viewLedger(box, kit) {
  const { h, api, pager, debounce, when } = kit;
  const s = ui.led;
  const list = h('div'), count = h('span.count');
  const card = h('input', { type: 'search', inputmode: 'numeric', placeholder: 'Քարտի համար (8 նիշ)', 'aria-label': 'Քարտի համար', value: s.card, maxlength: 9, oninput: debounce((e) => { s.card = e.target.value.replace(/\D/g, ''); s.page = 1; if (!s.card || s.card.length === 8) load(); }) });
  const sel = h('select', { 'aria-label': 'Տեսակ', onchange: (e) => { s.type = e.target.value; s.page = 1; load(); } }, h('option', { value: '' }, 'Բոլոր տեսակները'), Object.entries(TX_LABELS).map(([k, v]) => h('option', { value: k, selected: s.type === k }, v)));
  box.append(h('div.tools', {}, card, sel, count), list);
  async function load() {
    try {
      const d = await api('/pioneer/transactions?' + new URLSearchParams({ type: s.type, card: s.card, page: s.page }));
      s.page = d.page; count.textContent = `Ընդամենը՝ ${d.total}`;
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, 'Գործարքներ չեն գտնվել։')));
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Ամսաթիվ', 'Քարտ', 'Քարտատեր', 'Տեսակ', 'Միավոր', 'Մնացորդ', 'Մանրամասներ'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((x) => h('tr', {}, h('td', {}, when(x.createdAt)), h('td', {}, h('span.mono', {}, fmtCardNo(x.card))), h('td', {}, x.holder), h('td', {}, TX_LABELS[x.type]),
          h('td', {}, h('b.' + (x.amount > 0 ? 'pos' : 'neg'), {}, signed(x.amount))), h('td', {}, num(x.balanceAfter)),
          h('td', { style: 'white-space:normal;min-width:200px;font-size:13px' }, [x.counterparty ? `${x.type === 'transfer_out' ? '→' : '←'} ${fmtCardNo(x.counterparty)}` : '', x.description, x.reference, x.admin ? `ադմին՝ ${x.admin}` : ''].filter(Boolean).join(' · '))))))),
      pager(list, d.total, d.pageSize, d.page, (p) => { s.page = p; load(); }));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}

// ---------- announcements --------------------------------------------------------------------
async function viewNews(box, kit) {
  const { h, api, when } = kit;
  const list = h('div');
  box.append(h('div.tools', {}, h('button.btn.sm.p', { type: 'button', onclick: () => newsForm(kit, null, load) }, '+ Նոր հայտարարություն'),
    h('span.count', {}, 'Հրապարակվածները ցուցադրվում են քարտատերերի անձնական էջում։')), list);
  async function load() {
    try {
      const d = await api('/pioneer/announcements');
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, 'Հայտարարություններ չկան։')));
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Վերնագիր', 'Կարգավիճակ', 'Ստեղծվել է', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((a) => h('tr', {}, h('td', { style: 'white-space:normal' }, h('b', {}, a.title), a.body ? h('div.muted', { style: 'font-size:13px;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, a.body) : null),
          h('td', {}, h('span.st.' + a.status, {}, RW_ST[a.status])), h('td', {}, when(a.createdAt)),
          h('td.act', {}, h('button.btn.sm', { type: 'button', onclick: () => newsForm(kit, a, load) }, 'Խմբագրել'),
            h('button.btn.sm', { type: 'button', onclick: async () => { try { await api(`/pioneer/announcements/${a.id}`, { method: 'PATCH', body: { status: a.status === 'published' ? 'draft' : 'published' } }); load(); } catch (e) { if (e.message !== 'auth') alert(e.message); } } }, a.status === 'published' ? 'Հանել' : 'Հրապարակել'),
            h('button.btn.sm', { type: 'button', onclick: async () => { if (await confirmBox(kit, 'Արխիվացնե՞լ', 'Հայտարարությունը այլևս չի ցուցադրվի։', 'Արխիվացնել')) { try { await api(`/pioneer/announcements/${a.id}`, { method: 'PATCH', body: { status: 'archived' } }); load(); } catch (e) { if (e.message !== 'auth') alert(e.message); } } } }, 'Արխիվ'))))))));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}
function newsForm(kit, a, reload) {
  const { h, api, modal } = kit;
  const { field, show } = fieldsKit(h);
  a = a || {};
  const title = h('input', { maxlength: 120, value: a.title || '' }), body = h('textarea', { maxlength: 2000, rows: 6 }, a.body || '');
  const status = h('select', {}, Object.entries(RW_ST).map(([k, v]) => h('option', { value: k, selected: (a.status || 'draft') === k }, v)));
  const note = h('p.msg'), go = h('button.btn.p', { type: 'submit' }, a.id ? 'Պահպանել' : 'Ստեղծել');
  let close;
  const form = h('form', { style: 'padding:0;border:0;background:none', novalidate: true, onsubmit: async (e) => {
    e.preventDefault(); go.disabled = true; show(); note.textContent = '';
    try { await api(a.id ? `/pioneer/announcements/${a.id}` : '/pioneer/announcements', { method: a.id ? 'PATCH' : 'POST', body: { title: title.value, body: body.value, status: status.value } }); close(); reload(); }
    catch (x) { if (x.message === 'auth') return; show(x.fields); note.className = 'msg err'; note.textContent = x.message; }
    finally { go.disabled = false; }
  } }, field('Վերնագիր', title, 'title'), field('Տեքստ', body, 'body'), field('Կարգավիճակ', status, 'status'),
  h('p.help', {}, 'Գրեք միայն հաստատված տեղեկություններ․ քարտատերերը սա կընկալեն որպես Magical-ի պաշտոնական հայտարարություն։'), note, h('div.macts', { style: 'margin-top:14px' }, go));
  close = modal(a.id ? 'Խմբագրել հայտարարությունը' : 'Նոր հայտարարություն', form, { small: true });
}

// ---------- audit + settings ------------------------------------------------------------------
async function viewAudit(box, kit) {
  const { h, api, pager, when } = kit;
  const list = h('div');
  box.append(list);
  const detail = (x) => {
    const d = x.details || {};
    if (x.action === 'points.adjust') return `${signed(d.amount)} · ${d.reason}`;
    if (x.action === 'card.create') return `բոնուս՝ ${d.initialBonus}${d.named ? ' · անունով' : ''}`;
    if (x.action === 'card.update_holder') return (d.changed || []).map((k) => ({ first_name: 'անուն', last_name: 'ազգանուն', phone: 'հեռախոս' }[k])).join(', ');
    if (x.action === 'settings.initial_bonus') return `${d.from} → ${d.to}`;
    if (x.action === 'cards.bulk_retire') return d.outcome === 'ok' ? `${d.scope === 'all' ? 'բոլոր քարտերը' : 'ընտրված'} · ${d.selected} քարտ · ապաակտիվացվեց ${d.retired} · սեսիա ${d.sessionsEnded}` : `ձախողվեց (${d.error}) · ոչինչ չի փոխվել`;
    if (x.action === 'card.deactivate' && d.bulk) return 'զանգվածային';
    if (x.action === 'card.print') return `${d.position} / ${d.batch}`;
    if (x.action.startsWith('redemption.')) return `${d.reference} · ${d.points}${d.note ? ' · ' + d.note : ''}`;
    if (d.title) return d.title + (d.status ? ` · ${RW_ST[d.status] || d.status}` : '');
    return '';
  };
  async function load() {
    try {
      const d = await api(`/pioneer/audit?page=${ui.audit.page}`);
      if (!d.items.length) return list.replaceChildren(h('div.tbl', {}, h('div.empty', {}, 'Դեռ գործողություններ չկան։')));
      list.replaceChildren(h('div.tbl', {}, h('table', {},
        h('thead', {}, h('tr', {}, ['Ամսաթիվ', 'Ադմին', 'Գործողություն', 'Քարտ', 'Մանրամասներ'].map((t) => h('th', {}, t)))),
        h('tbody', {}, d.items.map((x) => h('tr', {}, h('td', {}, when(x.createdAt)), h('td', {}, x.admin), h('td', {}, AUDIT[x.action] || x.action), h('td', {}, x.card ? h('span.mono', {}, fmtCardNo(x.card)) : '—'), h('td', { style: 'white-space:normal;min-width:200px;font-size:13px' }, detail(x))))))),
      pager(list, d.total, d.pageSize, d.page, (p) => { ui.audit.page = p; load(); }));
    } catch (e) { if (e.message !== 'auth') list.replaceChildren(errBox(h, e)); }
  }
  await load();
}

async function viewSettings(box, kit) {
  const { h, api } = kit;
  const { field, show } = fieldsKit(h);
  let cur;
  try { cur = await api('/pioneer/settings'); } catch (e) { if (e.message !== 'auth') box.append(errBox(h, e)); return; }
  const bonus = h('input', { inputmode: 'numeric', maxlength: 6, value: cur.initialBonus });
  const note = h('p.msg'), go = h('button.btn.p', { type: 'submit' }, 'Պահպանել');
  box.append(h('div', { style: 'max-width:620px' },
    h('form', { novalidate: true, onsubmit: async (e) => {
      e.preventDefault(); go.disabled = true; show(); note.className = 'msg'; note.textContent = '';
      try { const r = await api('/pioneer/settings', { method: 'PUT', body: { initialBonus: bonus.value.trim() } }); bonus.value = r.initialBonus; note.textContent = 'Պահպանված է։ Կկիրառվի միայն նոր ստեղծվող քարտերի համար։'; }
      catch (x) { if (x.message === 'auth') return; show(x.fields); note.className = 'msg err'; note.textContent = x.message; }
      finally { go.disabled = false; }
    } }, h('h2', { style: 'font-size:19px;margin:0 0 6px' }, 'Մեկնարկային բոնուս'),
    field('Միավորներ յուրաքանչյուր նոր քարտի համար', bonus, 'initialBonus', { help: 'Լռելյայն՝ 200։ Տրվում է միայն մեկ անգամ՝ քարտը ստեղծելիս, և գրանցվում է գործարքների մատյանում։ Արդեն ստեղծված քարտերի վրա չի ազդում։' }), note, go),
    h('div.sec', {}, h('h3', {}, 'Անվտանգության նշումներ'), h('ul', { style: 'color:var(--mut);font-size:14px;line-height:1.7;padding-left:18px' },
      h('li', {}, 'CVV-ն ունի ընդամենը 1000 հնարավոր արժեք, ուստի մուտքը պաշտպանված է քարտի համարի վրա հիմնված արգելափակումով․ 3 սխալից հետո՝ ժամանակավոր, 10 սխալից հետո՝ մինչև ադմինիստրատորի ապակողպումը։'),
      h('li', {}, 'Արգելափակված քարտի տիրոջը ապակողպելուց առաջ համոզվեք, որ դիմողը իսկապես քարտատերն է։ Կասկածի դեպքում օգտագործեք «Վերականգնել CVV»։'),
      h('li', {}, 'CVV-ն պահվում է միայն հեշի տեսքով և ցուցադրվում է մեկ անգամ՝ ստեղծելիս կամ վերականգնելիս։ Այն երբեք չի տպվում քարտի վրա։')))));
}
