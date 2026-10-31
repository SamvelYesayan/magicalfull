// Pioneer Card helpers shared by the browser (instant feedback) and the server (authoritative).
// Pure functions, no dependencies. Messages are Armenian, like shared/validation.js.
import { clean, validateName, validatePhone } from './validation.js';

export const PIONEER_MSG = {
  cardNumber: 'Մուտքագրեք 8 նիշանոց քարտի համարը։',
  cvv: 'Մուտքագրեք 3 նիշանոց CVV կոդը։',
  amount: 'Մուտքագրեք միավորների ամբողջ թիվ (1-ից 1 000 000)։',
  adjust: 'Մուտքագրեք ոչ զրոյական ամբողջ թիվ (-1 000 000-ից 1 000 000)։',
  reason: 'Նշեք պատճառը (3-300 նիշ)։',
};
export const MEMBER_FALLBACK = 'Pioneer Member';
export const MAX_POINTS_OP = 1_000_000;

/** Strips spaces/dashes; returns the 8 digits or '' when the input is not an 8-digit number. */
export function normalizeCardNo(raw) {
  const d = String(raw ?? '').replace(/[\s\-–.]/g, '');
  return /^\d{8}$/.test(d) ? d : '';
}
export const normalizeCvv = (raw) => { const d = String(raw ?? '').trim(); return /^\d{3}$/.test(d) ? d : ''; };
export const formatCardNo = (n) => (/^\d{8}$/.test(n || '') ? `${n.slice(0, 4)} ${n.slice(4)}` : n || '');
export const maskCardNo = (n) => (/^\d{8}$/.test(n || '') ? `•••• ${n.slice(4)}` : '');
export const displayName = (first, last) => [first, last].filter(Boolean).join(' ') || MEMBER_FALLBACK;

/** Positive whole number of points (number or digit string), 1..MAX. Returns the integer or null. */
export function parsePoints(raw, { allowNegative = false } = {}) {
  const s = typeof raw === 'number' ? String(raw) : String(raw ?? '').replace(/\s/g, '');
  if (!(allowNegative ? /^[+-]?\d{1,7}$/ : /^\+?\d{1,7}$/).test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n === 0 || Math.abs(n) > MAX_POINTS_OP || (!allowNegative && n < 0)) return null;
  return n;
}

/** Optional holder fields entered by an admin. Empty strings mean "not provided" (null). */
export function validateHolder(input = {}) {
  const errors = {}, values = {};
  for (const k of ['firstName', 'lastName']) {
    if (!clean(input[k])) { values[k] = null; continue; }
    const r = validateName(input[k], '');
    if (r.error) errors[k] = r.error; else values[k] = r.value;
  }
  if (!clean(input.phone)) values.phone = null;
  else { const p = validatePhone(input.phone); if (p.error) errors.phone = p.error; else values.phone = p.value; }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

export const TX_LABELS = {
  initial_bonus: 'Մեկնարկային բոնուս',
  transfer_out: 'Ուղարկված փոխանցում',
  transfer_in: 'Ստացված փոխանցում',
  redemption: 'Պարգևի ձեռքբերում',
  redemption_refund: 'Պարգևի չեղարկում (վերադարձ)',
  admin_credit: 'Ադմինիստրատիվ հավելում',
  admin_debit: 'Ադմինիստրատիվ նվազեցում',
};

// Gift card for approved redemption requests: contact numbers shown on the card (display text + tel: value).
export const GIFT_PHONES = [['+374 93 882738', '+37493882738'], ['+374 99 755073', '+37499755073']];
export const GIFT_STATUS = { pending: 'Սպասում է հաստատման', approved: 'Հաստատված է · Պատրաստ է ստացման', fulfilled: 'Տրամադրված է', cancelled: 'Չեղարկված (միավորները վերադարձվել են)' };
