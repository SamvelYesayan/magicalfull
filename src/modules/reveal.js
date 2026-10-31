import { SERVICES } from '../../shared/validation.js';
// Scroll reveals, process line, card spotlight, contact form (sent to /api/contact)
// scroll reveals + process line
const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('on');io.unobserve(e.target)}}),{threshold:.15});
document.querySelectorAll('.rv,#steps').forEach(el=>io.observe(el));
// card spotlight follows cursor
document.addEventListener('pointermove',e=>{const c=e.target.closest&&e.target.closest('.card');if(c){const r=c.getBoundingClientRect();c.style.setProperty('--x',e.clientX-r.left+'px');c.style.setProperty('--y',e.clientY-r.top+'px')}});
// form
// contact form -> POST /api/contact (the form's markup and look are unchanged)
const form=document.getElementById('f'),btn=form.querySelector('button[type=submit]'),loaded=Date.now();
const hp=document.createElement('input');hp.type='text';hp.name='website';hp.tabIndex=-1;hp.autocomplete='off';hp.setAttribute('aria-hidden','true');hp.style.cssText='position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';form.appendChild(hp);
const status=document.createElement('p');status.className='f-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');btn.insertAdjacentElement('afterend',status);
const T={hy:{sending:'Ուղարկվում է…',net:'Չհաջողվեց կապ հաստատել սերվերի հետ։ Ստուգեք կապը և փորձեք կրկին։',rate:'Չափազանց շատ հարցումներ։ Խնդրում ենք փորձել մի փոքր ուշ։',server:'Սերվերի սխալ։ Ձեր հաղորդագրությունը չի պահպանվել, խնդրում ենք փորձել կրկին։',fields:'Խնդրում ենք ուղղել նշված դաշտերը։'},en:{sending:'Sending…',net:'Could not reach the server. Check your connection and try again.',rate:'Too many requests. Please try again a little later.',server:'Server error. Your message was not saved, please try again.',fields:'Please check the highlighted fields.'}};
const L=()=>document.documentElement.lang==='en'?T.en:T.hy;
const FIELDS={name:'n',email:'e',phone:'p',service:'s',message:'m'};
const show=(t,err)=>{status.textContent=t;status.classList.toggle('err',!!err)};
let busy=false;
form.addEventListener('submit',async e=>{
 e.preventDefault();if(busy)return;busy=true;btn.disabled=true;btn.setAttribute('aria-busy','true');
 Object.values(FIELDS).forEach(id=>document.getElementById(id).removeAttribute('aria-invalid'));show(L().sending,false);
 const g=id=>document.getElementById(id);
 try{
  const r=await fetch('/api/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:g('n').value,email:g('e').value,phone:g('p').value,service:SERVICES[g('s').selectedIndex]||'',message:g('m').value,website:hp.value,ts:loaded})});
  let d=null;try{d=await r.json()}catch(_){}
  if(r.status===201&&d&&d.ok){show('',false);g('fields').style.display='none';g('ok').style.display='block';return}
  if(r.status===422&&d&&d.error&&d.error.fields){let first=null;for(const[k,id]of Object.entries(FIELDS)){if(d.error.fields[k]){g(id).setAttribute('aria-invalid','true');first=first||{id,msg:d.error.fields[k]}}}
   show(document.documentElement.lang==='en'?L().fields:first?first.msg:L().fields,true);if(first)g(first.id).focus();return}
  show(r.status===429?L().rate:L().server,true);
 }catch(_){show(L().net,true)}
 finally{busy=false;btn.disabled=false;btn.removeAttribute('aria-busy')}
});
