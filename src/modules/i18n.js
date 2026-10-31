import { HY } from './translations.js';

// ---- language switch (EN / Armenian) ----
const orig=new WeakMap();let lang='hy';
try{lang=localStorage.getItem('lang')||'hy'}catch(e){}
const h1=document.getElementById('h1'),H1EN='Software, digital products and technology education from Armenia';
function setH1(txt){h1.innerHTML=txt.split(' ').map((w,i)=>`<span class="w" style="--n:${i}">${w}</span>`).join(' ');h1.setAttribute('aria-label',txt)}
function applyLang(l){lang=l;document.documentElement.lang=l==='hy'?'hy':'en';
 const w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:n=>n.parentElement.closest('script,style,pre,svg,h1')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT});
 let n;while(n=w.nextNode()){if(!orig.has(n))orig.set(n,n.nodeValue);const o=orig.get(n),k=o.trim();if(!k)continue;n.nodeValue=(l==='hy'&&HY[k])?o.replace(k,HY[k]):o}
 document.querySelectorAll('[placeholder]').forEach(el=>{if(!el.dataset.en)el.dataset.en=el.placeholder;el.placeholder=(l==='hy'&&HY[el.dataset.en])?HY[el.dataset.en]:el.dataset.en});
 setH1(l==='hy'?HY[H1EN]:H1EN);
 document.getElementById('lg').textContent=l==='hy'?'EN':'ՀԱՅ';
 document.title=l==='hy'?'MAGICAL — Ծրագրային լուծումներ, թվային արտադրանքներ և տեխնոլոգիական կրթություն':'MAGICAL — Software, digital products and technology education';
 try{localStorage.setItem('lang',l)}catch(e){}}
document.getElementById('lg').addEventListener('click',()=>applyLang(lang==='hy'?'en':'hy'));
applyLang(lang);
