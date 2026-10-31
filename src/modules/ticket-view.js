// On-screen invitation ticket (mirrors the PDF layout). All dynamic text is escaped.
import { EVENT } from '../../shared/event.js';
import { code39 } from '../../shared/code39.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function barcode(number) {
  const code = number.replace(/^MGC-/, '');
  const { bars, width } = code39(code, 2);
  const rects = bars.map((b) => `<rect x="${b.x}" y="0" width="${b.w}" height="46"/>`).join('');
  return `<svg class="tk-bars" viewBox="0 0 ${width} 46" preserveAspectRatio="none" role="img" aria-label="${esc(code)}" fill="#0a0a0c">${rects}</svg><div class="tk-code">${esc(code)}</div>`;
}

export function ticketHtml({ number, firstName, lastName }) {
  return `<article class="tk" aria-label="${esc(EVENT.name)}">
  <div class="tk-main">
    <div class="tk-top"><div class="tk-brand"><img src="/assets/magical-m.png" alt="" width="36" height="26"><b>MAGICAL</b></div><span class="tk-pill">ՀՐԱՎԻՐԱՏՈՄՍ</span></div>
    <div class="tk-lab">ՀՐԱՎԻՐՎՈՒՄ Է</div>
    <h2 class="tk-name">${esc(firstName)} ${esc(lastName)}</h2>
    <div class="tk-ev">«${esc(EVENT.name)}»</div>
    <dl class="tk-info"><div><dt>ԱՄՍԱԹԻՎ</dt><dd>${esc(EVENT.dateText)}</dd></div><div><dt>ԺԱՄ</dt><dd>${esc(EVENT.time)}</dd></div><div class="tk-loc"><dt>ՎԱՅՐ</dt><dd>${esc(EVENT.location)}</dd></div></dl>
    <p class="tk-note"><i></i>${esc(EVENT.giftsNote)}</p>
  </div>
  <div class="tk-perf" aria-hidden="true"></div>
  <div class="tk-stub">
    <div class="tk-lab">ՀՐԱՎԻՐԱՏՈՄՍԻ ՀԱՄԱՐ</div>
    <div class="tk-no">${esc(number)}</div>
    <div class="tk-bc">${barcode(number)}</div>
    <div class="tk-motto"><span>LEARN.</span><span>BUILD.</span><span>CONQUER.</span></div>
  </div>
</article>`;
}
