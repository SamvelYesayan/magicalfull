// Validation shared by the browser (instant feedback) and the server (authoritative).
// All messages are Armenian. Pure functions, no dependencies.

const SCRIPTS = '\\p{Script=Armenian}\\p{Script=Latin}\\p{Script=Cyrillic}';
const NAME_RE = new RegExp(`^[${SCRIPTS}][${SCRIPTS}\\p{M} '’.\\-]*$`, 'u');

export const MSG = {
  firstNameRequired: 'Մուտքագրեք ձեր անունը։',
  lastNameRequired: 'Մուտքագրեք ձեր ազգանունը։',
  nameShort: 'Նվազագույնը 2 նիշ։',
  nameLong: 'Առավելագույնը 50 նիշ։',
  nameChars: 'Թույլատրվում են միայն հայերեն, լատինատառ կամ կիրիլյան տառեր։',
  ageRequired: 'Մուտքագրեք ձեր տարիքը։',
  ageInvalid: 'Տարիքը պետք է լինի ամբողջ թիվ՝ 1-ից 120։',
  phoneRequired: 'Մուտքագրեք հեռախոսահամարը։',
  phoneInvalid: 'Մուտքագրեք վավեր հեռախոսահամար, օրինակ՝ +374 77 123456 կամ 077 123456։',
  emailRequired: 'Մուտքագրեք էլ. փոստի հասցեն։',
  emailInvalid: 'Մուտքագրեք վավեր էլ. փոստի հասցե։',
  messageLong: 'Հաղորդագրությունը չափազանց երկար է (առավելագույնը 3000 նիշ)։',
  messageLinks: 'Հաղորդագրությունը պարունակում է չափազանց շատ հղումներ։',
  nameFull: 'Մուտքագրեք ձեր անունը։',
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
export const clean = (v) => str(v).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

export function validateName(raw, requiredMsg) {
  const v = clean(raw);
  if (!v) return { error: requiredMsg };
  if ([...v].length < 2) return { error: MSG.nameShort };
  if ([...v].length > 50) return { error: MSG.nameLong };
  if (!NAME_RE.test(v)) return { error: MSG.nameChars };
  return { value: v };
}

export function validateAge(raw) {
  const v = str(raw).trim();
  if (!v) return { error: MSG.ageRequired };
  if (!/^\d{1,3}$/.test(v)) return { error: MSG.ageInvalid };
  const n = Number(v);
  if (n < 1 || n > 120) return { error: MSG.ageInvalid };
  return { value: n };
}

/**
 * Accepts Armenian numbers in any common notation:
 *   +374 77 123456, +37477123456, 00374 77 123456, 374-77-123456, 077123456, (077) 12-34-56, 77123456
 * Also accepts other international numbers written with a leading "+" (7-15 digits).
 * Returns canonical "+374XXXXXXXX" (Armenian) or "+<digits>".
 */
export function validatePhone(raw) {
  let v = str(raw).trim();
  if (!v) return { error: MSG.phoneRequired };
  if (!/^[+\d\s().\-]+$/.test(v)) return { error: MSG.phoneInvalid };
  const plus = v.startsWith('+');
  let d = v.replace(/\D/g, '');
  if (!plus && d.startsWith('00')) d = d.slice(2), (v = '+' + d);
  const intl = plus || v.startsWith('+');
  let national;
  if (d.startsWith('374') && (intl || d.length === 11)) national = d.slice(3);
  else if (!intl && d.startsWith('0')) national = d.slice(1);
  else if (!intl && d.length === 8) national = d;
  else if (intl) {
    if (d.length < 7 || d.length > 15 || d.startsWith('0')) return { error: MSG.phoneInvalid };
    return { value: '+' + d };
  } else return { error: MSG.phoneInvalid };
  if (!/^[1-9]\d{7}$/.test(national)) return { error: MSG.phoneInvalid };
  return { value: '+374' + national };
}

export function formatPhone(canonical) {
  const m = /^\+374(\d{2})(\d{6})$/.exec(canonical || '');
  return m ? `+374 ${m[1]} ${m[2]}` : canonical || '';
}

export function validateEmail(raw) {
  const v = str(raw).trim();
  if (!v) return { error: MSG.emailRequired };
  if (v.length > 254 || !/^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[A-Za-z\u0561-\u0586]{2,}$/.test(v)) return { error: MSG.emailInvalid };
  return { value: v.toLowerCase() };
}

export function validateRegistration(input = {}) {
  const errors = {};
  const values = {};
  const f = validateName(input.firstName, MSG.firstNameRequired);
  const l = validateName(input.lastName, MSG.lastNameRequired);
  const a = validateAge(input.age);
  const p = validatePhone(input.phone);
  for (const [k, r] of [['firstName', f], ['lastName', l], ['age', a], ['phone', p]]) {
    if (r.error) errors[k] = r.error;
    else values[k] = r.value;
  }
  return { ok: Object.keys(errors).length === 0, values, errors };
}

export const SERVICES = [
  'Web Development', 'Software Development', 'Mobile Applications',
  'UI/UX Design', 'Digital Products', 'Technology Education',
];

export function validateContact(input = {}) {
  const errors = {};
  const values = {};
  const n = clean(input.name);
  if (!n) errors.name = MSG.nameFull;
  else if ([...n].length > 100) errors.name = MSG.nameLong;
  else values.name = n;
  const e = validateEmail(input.email);
  if (e.error) errors.email = e.error; else values.email = e.value;
  const rawPhone = str(input.phone).trim();
  if (rawPhone) {
    const p = validatePhone(rawPhone);
    if (p.error) errors.phone = p.error; else values.phone = p.value;
  } else values.phone = '';
  const svc = str(input.service).trim();
  values.service = SERVICES.includes(svc) ? svc : '';
  if (svc && !values.service) errors.service = 'Անվավեր ծառայություն։';
  const msg = str(input.message).normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if ([...msg].length > 3000) errors.message = MSG.messageLong;
  else if ((msg.match(/https?:\/\//gi) || []).length > 3) errors.message = MSG.messageLinks;
  else values.message = msg;
  return { ok: Object.keys(errors).length === 0, values, errors };
}
