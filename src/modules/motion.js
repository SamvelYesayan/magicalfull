// Motion layer: star field, parallax, tilt, magnetic buttons, cursor glow, progress bar
// ---- motion layer ----
(()=>{
const RM=matchMedia('(prefers-reduced-motion:reduce)').matches,FINE=matchMedia('(hover:hover) and (pointer:fine)').matches,$=s=>document.querySelectorAll(s);
$('.head,.fg>div:first-child').forEach(p=>[...p.children].forEach((c,i)=>c.style.setProperty('--i',i)));
const sio=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('on');sio.unobserve(e.target)}}),{threshold:.15});
$('section,.head,.fg>div:first-child,.copy').forEach(e=>sio.observe(e));
const cio=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){setTimeout(()=>e.target.classList.add('done'),1700);cio.unobserve(e.target)}}));
$('.card.rv').forEach(c=>cio.observe(c));
if(FINE&&!RM){
 $('.card').forEach(c=>{c.addEventListener('pointermove',e=>{const r=c.getBoundingClientRect();c.style.setProperty('--rx',(-((e.clientY-r.top)/r.height-.5)*6).toFixed(2)+'deg');c.style.setProperty('--ry',(((e.clientX-r.left)/r.width-.5)*8).toFixed(2)+'deg')});c.addEventListener('pointerleave',()=>{c.style.setProperty('--rx','0deg');c.style.setProperty('--ry','0deg')})});
 $('.btn').forEach(b=>{b.addEventListener('pointermove',e=>{const r=b.getBoundingClientRect();b.style.setProperty('--mx',((e.clientX-r.left-r.width/2)*.18).toFixed(1)+'px');b.style.setProperty('--my',((e.clientY-r.top-r.height/2)*.28).toFixed(1)+'px')});b.addEventListener('pointerleave',()=>{b.style.setProperty('--mx','0px');b.style.setProperty('--my','0px')})});
 const cg=document.getElementById('cg');let tx=0,ty=0,x=0,y=0,run=0;
 const mv=()=>{x+=(tx-x)*.12;y+=(ty-y)*.12;cg.style.transform=`translate(${x}px,${y}px)`;run=(Math.abs(tx-x)+Math.abs(ty-y)>.5)?requestAnimationFrame(mv):0};
 addEventListener('pointermove',e=>{tx=e.clientX;ty=e.clientY;cg.style.opacity=1;if(!run)run=requestAnimationFrame(mv)},{passive:true});
 document.addEventListener('pointerleave',()=>cg.style.opacity=0);
}
// parallax + scroll progress (one rAF-throttled handler)
const P=[...$('[data-p]')],S=[...$('[data-s]')],pg=document.getElementById('pg'),hd=document.querySelector('header');let tk=0;
function par(){tk=0;const vh=innerHeight,sy=scrollY;
 P.forEach(el=>{const r=el.parentElement.getBoundingClientRect();if(r.bottom<-200||r.top>vh+200)return;el.style.translate='0 '+((r.top+r.height/2-vh/2)*el.dataset.p).toFixed(1)+'px'});
 if(sy<1400)S.forEach(el=>el.style.translate='0 '+(sy*el.dataset.s).toFixed(1)+'px');
 pg.style.transform='scaleX('+Math.min(1,sy/Math.max(1,document.documentElement.scrollHeight-vh)).toFixed(4)+')';hd.classList.toggle('sc',sy>20)}
addEventListener('scroll',()=>{if(!tk)tk=requestAnimationFrame(par)},{passive:true});
if(!RM)par();
// purple star field (canvas 2D, ~30fps, paused when tab hidden)
const cv=document.getElementById('stars'),cx=cv.getContext('2d');let W,H,st=[],lw=0,dpr=Math.min(devicePixelRatio||1,1.5),last=0;
function rs(){if(innerWidth===lw&&st.length)return;lw=innerWidth;W=cv.width=innerWidth*dpr;H=cv.height=innerHeight*dpr;st=Array.from({length:innerWidth<700?45:95},()=>({x:Math.random()*W,y:Math.random()*H,r:(.4+Math.random()*1.1)*dpr,p:Math.random()*6.28,s:.5+Math.random()*1.5,d:.15+Math.random()*.85,c:Math.random()<.6?'167,139,250':'255,255,255'}))}
function draw(t){cx.clearRect(0,0,W,H);const sy=scrollY*dpr;st.forEach(o=>{const y=((o.y-sy*o.d*.12)%H+H)%H,a=RM?.5:.25+.6*(.5+.5*Math.sin(t/1000*o.s+o.p));cx.fillStyle='rgba('+o.c+','+a.toFixed(2)+')';cx.beginPath();cx.arc(o.x+(RM?0:Math.sin(t/6000*o.s+o.p)*6*dpr),y,o.r,0,6.28);cx.fill()})}
function loop(t){if(!document.hidden&&t-last>32){last=t;draw(t)}requestAnimationFrame(loop)}
rs();addEventListener('resize',()=>{rs();if(RM)draw(0)});
if(RM){draw(0);addEventListener('scroll',()=>draw(0),{passive:true})}else requestAnimationFrame(loop);
})();
