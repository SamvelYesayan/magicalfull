// Typed code window in the hero
const lines=[`<span class="k">1  import { learn, build, conquer } from 'magical'</span>`,`<span class="wt">2  const product = await build({ idea: 'your project' })</span>`,`3  product.on('ready', () => console.log('Launched'))`,`<span class="k">4  export default conquer(product)</span>`];
const pre=document.getElementById('codeout'),reduce=matchMedia('(prefers-reduced-motion:reduce)').matches;
function type(){let l=0,c=0,done='';const tick=()=>{if(l>=lines.length){pre.innerHTML=done+'<span class="caret"></span>';return}
 const raw=lines[l].replace(/<[^>]+>/g,''),tags=lines[l].match(/^<span class="(\w+)">/);c+=2;const part=raw.slice(0,c);
 const cur=tags?`<span class="${tags[1]}">${part}</span>`:part;
 if(c>=raw.length){done+=(tags?`<span class="${tags[1]}">${raw}</span>`:raw)+'\n';l++;c=0;pre.innerHTML=done+'<span class="caret"></span>';setTimeout(tick,220)}else{pre.innerHTML=done+cur+'<span class="caret"></span>';setTimeout(tick,18)}};tick()}
if(reduce){pre.innerHTML=lines.join('\n')}else setTimeout(type,1800);
