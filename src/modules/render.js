import { services, principles, processSteps } from './content.js';

const I=n=>`<svg class="i"><use href="#${n}"/></svg>`;
const H=(id,a)=>document.getElementById(id).innerHTML=a;
H('svc',services.map((s,i)=>`<div class="card rv" style="--d:${i%3*100}ms"><div class="ic">${I(s[0])}</div><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join(''));
H('whyg',principles.map((s,i)=>`<div class="card rv" style="--d:${i*90}ms"><h3>${I(s[0])}${s[1]}</h3><p>${s[2]}</p></div>`).join(''));
H('steps',processSteps.map((s,i)=>`<div class="st rv" style="--d:${i*250}ms"><div class="c">${I(s[0])}<em>${i+1}</em></div><div><h3>${s[1]}</h3><p>${s[2]}</p></div></div>`).join(''));
// typed code
