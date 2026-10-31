// On-screen / printable Pioneer Card (mirrors server/pdf/pioneer-card.js). All dynamic text is escaped.
// Never shows the CVV or the phone number.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtCardNo = (n) => (/^\d{8}$/.test(n || '') ? `${n.slice(0, 4)} ${n.slice(4)}` : esc(n));

export function cardHtml({ number, firstName, lastName }, { label = 'Magical Pioneer Card' } = {}) {
  const name = [firstName, lastName].filter(Boolean).join(' ');
  return `<div class="pc${name ? '' : ' pc-noname'}" role="img" aria-label="${esc(label)} ${esc(fmtCardNo(number))}">
  <span class="pc-rings" aria-hidden="true"></span>
  <span class="pc-brand"><img src="/assets/magical-m.png" alt="">MAGICAL</span>
  <span class="pc-title">PIONEER CARD</span>
  <span class="pc-lab pc-l1">CARD NUMBER</span>
  <span class="pc-no">${fmtCardNo(number)}</span>
  <span class="pc-lab pc-l2">CARDHOLDER</span>
  ${name ? `<span class="pc-name">${esc(name)}</span>` : '<span class="pc-blank" aria-hidden="true"></span>'}
  <span class="pc-mem"><i></i>MEMBER</span>
  <span class="pc-site">magical.am</span>
  <span class="pc-strip" aria-hidden="true"></span>
</div>`;
}

// Simple line icons for rewards (fixed set, matches the icon CHECK constraint in the database).
const P = {
  spark: '<path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z"/>',
  code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14"/>',
  design: '<circle cx="12" cy="12" r="8"/><circle cx="9" cy="10" r="1.2"/><circle cx="14.5" cy="9" r="1.2"/><path d="M12 20a2 2 0 0 1 0-4h2a2 2 0 0 0 2-2"/>',
  mobile: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M4 13h16M12 9v11M12 9c-2-4-6-4-6-1.5S10 9 12 9zm0 0c2-4 6-4 6-1.5S14 9 12 9z"/>',
  star: '<path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z"/>',
  book: '<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5zM5 20.5A2.5 2.5 0 0 1 7.5 18H19v3H7.5"/>',
  rocket: '<path d="M14 4c3 0 6 3 6 6l-7 7-6-6 7-7zM7 11l-3 1 2 2M13 17l-1 3-2-2M15.5 8.5h.01"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  arrow: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  phone: '<path d="M5 4h3.5l1.6 4.2-2.2 1.4a11 11 0 0 0 6.5 6.5l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  print: '<path d="M7 9V4h10v5M7 17H5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5 9h14a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 19 17h-2M7 14h10v6H7z"/>',
};
export const ICON_KEYS = ['spark', 'code', 'design', 'mobile', 'gift', 'star', 'book', 'rocket'];
export const icon = (k, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[k] || P.spark}</svg>`;
