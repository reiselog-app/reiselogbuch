(function(){
"use strict";
const MONTHS=["Januar","Februar","März","April","Mai","Juni","Juli","August","September","Oktober","November","Dezember"];
const WD=["So","Mo","Di","Mi","Do","Fr","Sa"];
const VMA_FULL=28, VMA_PART=14, CUT_BF=5.6, CUT_MEAL=11.2;
const TRANSPORT={bahn:"Bahn",mietwagen:"Mietwagen",pkw:"Privat-PKW",sonst:"Sonstiges"};
const KINDS=["Hotel","Taxi","Parken","ÖPNV","Bahn","Tanken","Bewirtung","Sonstiges"];
const TESSERACT_URL="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const BACKUP_DAYS=7;

let trips=[], months={}, meta={};
const state={year:String(new Date().getFullYear())};
const $=id=>document.getElementById(id);
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const pd=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const fmtD=s=>{const d=pd(s);return String(d.getDate()).padStart(2,"0")+"."+String(d.getMonth()+1).padStart(2,"0")+"."};
const eur=n=>n.toLocaleString("de-DE",{minimumFractionDigits:2,maximumFractionDigits:2})+" €";
const iso=d=>d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
const defaultKS=()=>meta.ks||"";
const rcSum=rs=>(rs||[]).reduce((a,r)=>a+(Number(r.amount)||0),0);
function toast(t){const el=$("toast");el.textContent=t;el.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>el.hidden=true,2400)}

/* ================= IndexedDB ================= */
let dbp=null;
function idb(){
  if(dbp) return dbp;
  dbp=new Promise((ok,no)=>{
    const r=indexedDB.open("reiselogbuch",1);
    r.onupgradeneeded=()=>{const d=r.result;
      d.createObjectStore("trips",{keyPath:"id"});
      d.createObjectStore("files",{keyPath:"id"});
      d.createObjectStore("meta");};
    r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);
  });
  return dbp;
}
async function tx(store,mode,fn){
  const d=await idb();
  return new Promise((ok,no)=>{const t=d.transaction(store,mode);const s=t.objectStore(store);
    let res;const r=fn(s);if(r&&"onsuccess" in r)r.onsuccess=()=>res=r.result;
    t.oncomplete=()=>ok(res);t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});
}
const dbAll=s=>tx(s,"readonly",st=>st.getAll());
const dbPut=(s,v,k)=>tx(s,"readwrite",st=>k===undefined?st.put(v):st.put(v,k));
const dbGet=(s,k)=>tx(s,"readonly",st=>st.get(k));
const dbDel=(s,k)=>tx(s,"readwrite",st=>st.delete(k));
async function loadAll(){
  trips=await dbAll("trips");
  months=(await dbGet("meta","months"))||{};
  meta=(await dbGet("meta","info"))||{};
}
async function saveMeta(){await dbPut("meta",meta,"info")}

/* ================= Pauschalen ================= */
function calc(t){
  if(!t.start) return {days:0,nights:0,vma:0};
  const s=pd(t.start), e=pd(t.end||t.start);
  const days=Math.round((e-s)/864e5)+1, nights=Math.max(0,days-1);
  let vma=0;
  if(days===1){
    if(t.dep&&t.ret){const [h1,m1]=t.dep.split(":").map(Number),[h2,m2]=t.ret.split(":").map(Number);
      if((h2*60+m2)-(h1*60+m1)>8*60) vma=VMA_PART;}
  } else vma=2*VMA_PART+(days-2)*VMA_FULL;
  vma-=(Number(t.breakfasts)||0)*CUT_BF+(Number(t.meals)||0)*CUT_MEAL;
  return {days,nights,vma:Math.max(0,Math.round(vma*100)/100)};
}

/* ================= Belegerkennung (im Gerät) ================= */
let tessP=null;
function loadTesseract(){
  if(window.Tesseract) return Promise.resolve(window.Tesseract);
  if(tessP) return tessP;
  tessP=new Promise((ok,no)=>{const s=document.createElement("script");s.src=TESSERACT_URL;s.onload=()=>ok(window.Tesseract);s.onerror=()=>{tessP=null;no(new Error("load"))};document.head.appendChild(s)});
  return tessP;
}
async function prepImage(file,max,gray){
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=url});
    const s=Math.min(1,max/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*s);c.height=Math.round(img.naturalHeight*s);
    const x=c.getContext("2d");x.drawImage(img,0,0,c.width,c.height);
    if(gray){const d=x.getImageData(0,0,c.width,c.height),p=d.data;
      for(let i=0;i<p.length;i+=4){let v=.299*p[i]+.587*p[i+1]+.114*p[i+2];v=v>165?255:v<90?0:(v-90)*3.4;p[i]=p[i+1]=p[i+2]=v}
      x.putImageData(d,0,0);}
    return await new Promise(ok=>c.toBlob(ok,"image/jpeg",gray?.92:.8));
  }finally{URL.revokeObjectURL(url)}
}
let pdfP=null;
function loadPdf(){if(window.jspdf)return Promise.resolve(window.jspdf);if(pdfP)return pdfP;
  pdfP=new Promise((ok,no)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";s.onload=()=>ok(window.jspdf);s.onerror=()=>{pdfP=null;no(new Error("load"))};document.head.appendChild(s)});return pdfP}
// Foto -> PDF (A4, hohe Auflösung, Ausrichtung wie im Foto)
async function photoToPdf(file){
  const {jsPDF}=await loadPdf();
  const url=URL.createObjectURL(file);
  try{
    const img=await new Promise((ok,no)=>{const i=new Image();i.onload=()=>ok(i);i.onerror=no;i.src=url});
    const s=Math.min(1,3500/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");c.width=Math.round(img.naturalWidth*s);c.height=Math.round(img.naturalHeight*s);
    const x=c.getContext("2d");x.fillStyle="#fff";x.fillRect(0,0,c.width,c.height);x.drawImage(img,0,0,c.width,c.height);
    const jpg=c.toDataURL("image/jpeg",.92);
    const land=c.width>c.height, doc=new jsPDF({orientation:land?"landscape":"portrait",unit:"mm",format:"a4",compress:true});
    const pw=doc.internal.pageSize.getWidth(),ph=doc.internal.pageSize.getHeight(),m=8;
    const k=Math.min((pw-2*m)/c.width,(ph-2*m)/c.height),w=c.width*k,h=c.height*k;
    doc.addImage(jpg,"JPEG",(pw-w)/2,(ph-h)/2,w,h,undefined,"NONE");
    doc.setProperties({title:"Beleg",creator:"Reise-Logbuch"});
    return doc.output("blob");
  }finally{URL.revokeObjectURL(url)}
}
function parseAmount(s){const m=s.replace(/\s/g,"").match(/^(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})$/);return m?Number(m[1].replace(/\./g,"")+"."+m[2]):null}
function parseReceipt(text){
  const lines=text.split(/\n/).map(l=>l.trim()).filter(Boolean);
  const low=text.toLowerCase();
  const amtRe=/(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g;
  let amount=null;
  const keyRe=/(gesamt|summe|total|zu zahlen|endbetrag|betrag|brutto|bar|ec-?karte|kreditkarte|visa|mastercard)/i;
  const keyAmts=[];
  lines.forEach(l=>{if(keyRe.test(l)&&!/(netto|mwst|ust|steuer|rückgeld|gegeben)/i.test(l)){(l.match(amtRe)||[]).forEach(a=>{const v=parseAmount(a);if(v&&v<5000)keyAmts.push(v)})}});
  if(keyAmts.length) amount=Math.max(...keyAmts);
  else{const all=(text.match(amtRe)||[]).map(parseAmount).filter(v=>v&&v<5000);if(all.length)amount=Math.max(...all)}
  let date=null;const today=new Date();
  const dRe=/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})(?!\d)/g;let m;
  while((m=dRe.exec(text))){let [,d,mo,y]=m;y=y.length===2?"20"+y:y;
    const dt=new Date(+y,+mo-1,+d);
    if(dt.getMonth()===+mo-1&&dt<=today&&today-dt<400*864e5){date=iso(dt);break}}
  const kinds=[["Hotel",/(hotel|übernachtung|ubernachtung|logis|zimmer|accommodation|ibis|motel one|b&b hotels|nh |maritim|mercure|novotel|h\+)/],
    ["Taxi",/(taxi|uber|freenow|free now|bolt)/],["Parken",/(park|apcoa|contipark|q-park|parkhaus|parkschein)/],
    ["Bahn",/(deutsche bahn|db fernverkehr|bahn\.de|ice |ic\/ec|db vertrieb)/],["ÖPNV",/(bvg|mvg|hvv|vbb|kvb|rmv|fahrschein|einzelfahrt|tageskarte|s-bahn|u-bahn)/],
    ["Tanken",/(tankstelle|aral|shell|esso|jet |total ?energies|super e10|diesel|liter)/],["Bewirtung",/(restaurant|gaststätte|bewirtung|speisen|getränke|bistro|café|cafe|pizzeria|trattoria)/]];
  let kind="Sonstiges";for(const [k,re] of kinds){if(re.test(low)){kind=k;break}}
  let vendor=null;for(const l of lines.slice(0,6)){const c=l.replace(/[^\p{L}\p{N}&+.\- ]/gu,"").trim();if(c.length>=3&&c.length<=40&&/\p{L}{3}/u.test(c)&&!/(rechnung|quittung|beleg|invoice|datum|kasse)/i.test(c)){vendor=c;break}}
  let breakfasts=null;const bm=low.match(/fr(?:ü|u|ue)hst(?:ü|u|ue)ck\D{0,12}?(\d{1,2})\s*[x×]/)||low.match(/(\d{1,2})\s*[x×]\s*fr(?:ü|u|ue)hst/);
  if(bm)breakfasts=+bm[1];
  return {kind,amount,date,vendor,breakfasts};
}
async function ocr(file,onProgress){
  const T=await loadTesseract();
  const img=await prepImage(file,2000,true);
  const r=await T.recognize(img,"deu",{logger:m=>{if(m.status==="recognizing text"&&onProgress)onProgress(Math.round(m.progress*100))}});
  return parseReceipt(r.data.text||"");
}

/* ================= Standort ================= */
function getPos(maxAge=60000){
  return new Promise(ok=>{
    if(!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(p=>ok({lat:+p.coords.latitude.toFixed(5),lon:+p.coords.longitude.toFixed(5),acc:Math.round(p.coords.accuracy)}),()=>ok(null),{enableHighAccuracy:true,timeout:15000,maximumAge:maxAge});
  });
}
async function placeName(lat,lon){
  try{
    const r=await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=14&accept-language=de`,{headers:{"Accept":"application/json"}});
    if(!r.ok) return null;const j=await r.json(),a=j.address||{};
    const city=a.city||a.town||a.village||a.municipality||a.county;
    const part=a.suburb||a.city_district||a.borough||a.quarter;
    return city?(part&&part!==city?`${city}-${part}`:city):(j.name||null);
  }catch(e){return null}
}
function distKm(a,b){const R=6371,r=x=>x*Math.PI/180,dl=r(b.lat-a.lat),dn=r(b.lon-a.lon);
  const h=Math.sin(dl/2)**2+Math.cos(r(a.lat))*Math.cos(r(b.lat))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h))}
// Reiseziel = Punkt der Route, der am weitesten vom Start entfernt ist
async function guessPlace(t){
  const st=(t.route||[]).filter(s=>s.lat!=null);if(st.length<2)return "";
  const home=st[0];let best=null,bd=-1;
  for(const s of st.slice(1)){const d=distKm(home,s);if(d>bd){bd=d;best=s}}
  if(!best||bd<5)return "";
  if(!best.label)best.label=await placeName(best.lat,best.lon);
  return best.label?cityOnly(best.label):"";
}
const stopLabel=s=>s.label||(s.lat!=null?`${s.lat.toFixed(3)}, ${s.lon.toFixed(3)}`:"Ort unbekannt");
const cityOnly=s=>(s||"").split("-")[0];
function routeText(t){
  const r=t.route||[];if(!r.length)return "";
  const parts=[cityOnly(stopLabel(r[0]))];
  const goals=r.filter(s=>s.type==="ziel").map(s=>cityOnly(stopLabel(s)));
  if(goals.length)parts.push(...goals);else if(t.place)parts.push(t.place);
  const end=r.find(s=>s.type==="ende");if(end)parts.push(cityOnly(stopLabel(end)));
  return parts.filter((v,i,a)=>i===0||v!==a[i-1]).join(" → ");
}
// Standort still mitschreiben, solange eine Reise läuft (höchstens alle 20 Minuten)
let passiveBusy=false;
async function logPassive(force){
  const t=trips.find(x=>x.id===meta.activeTrip);if(!t||passiveBusy)return;
  const last=(t.route||[]).at(-1);if(!force&&last&&Date.now()-new Date(last.at).getTime()<20*60000)return;
  passiveBusy=true;
  try{const p=await getPos(0);if(p){t.route=[...(t.route||[]),{type:"punkt",at:new Date().toISOString(),...p}];await dbPut("trips",t)}}
  finally{passiveBusy=false}
}
function hhmm(d){return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0")}
async function logStop(type){
  const now=new Date();
  toast("Standort wird ermittelt …");
  const pos=await getPos(0);
  const stop={type,at:now.toISOString(),...(pos||{})};
  if(pos) stop.label=await placeName(pos.lat,pos.lon);
  let t=trips.find(x=>x.id===meta.activeTrip);
  if(type==="start"){
    t={id:"t"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),start:iso(now),end:iso(now),dep:hhmm(now),ret:"",place:"",purpose:"",transport:"bahn",km:"",breakfasts:0,meals:0,hotelReceipt:false,note:"",receipts:[],route:[stop],ks:defaultKS(iso(now))};
    trips.push(t);meta.activeTrip=t.id;
  } else {
    if(!t){toast("Keine laufende Reise gefunden");return}
    t.route=[...(t.route||[]),stop];
    if(type==="ziel"&&!t.place&&stop.label) t.place=cityOnly(stop.label);
    if(type==="ende"){t.end=iso(now);t.ret=hhmm(now);meta.activeTrip=null;if(!t.place)t.place=await guessPlace(t)}
  }
  await dbPut("trips",t);await markChanged();
  state.year=t.start.slice(0,4);render();
  toast(pos?`${type==="start"?"Abfahrt":type==="ziel"?"Ankunft":"Rückkehr"} ${hhmm(now)} · ${stop.label||"Standort gespeichert"}`:`${hhmm(now)} gespeichert, Standort nicht verfügbar`);
  if(type==="ende") openSheet(t);
}
function renderLive(){
  const el=$("live"), t=trips.find(x=>x.id===meta.activeTrip);
  if(!t){el.innerHTML=`<div class="live-txt"><b>Dienstreise starten</b><span>Ein Tipp beim Losgehen speichert Uhrzeit und Ort.</span></div>
    <button class="btn primary" data-act="go">Abfahrt jetzt</button>`;return}
  const first=t.route?.[0];
  el.innerHTML=`<div class="live-txt"><b><span class="dot"></span>Unterwegs seit ${esc(t.dep)}${t.start!==iso(new Date())?" ("+fmtD(t.start)+")":""}</b>
    <span>${esc(routeText(t)||stopLabel(first||{}))}</span></div>
    <div class="live-btns"><button class="btn" data-act="scan">Beleg scannen</button><button class="btn" data-act="arrive">Ziel erreicht</button><button class="btn primary" data-act="home">Zurück zu Hause</button>
    <button class="btn ghost small" data-act="edit" data-id="${t.id}">Bearbeiten</button></div>`;
}

/* ================= Render ================= */
function years(){
  const ys=new Set([String(new Date().getFullYear())]);
  trips.forEach(t=>t.start&&ys.add(t.start.slice(0,4)));
  return [...ys].sort().reverse();
}
function render(){
  const sel=$("yearSel"), ys=years();
  if(!ys.includes(state.year)) state.year=ys[0];
  sel.innerHTML=ys.map(y=>`<option ${y===state.year?"selected":""}>${y}</option>`).join("");
  const yt=trips.filter(t=>t.start&&t.start.startsWith(state.year)).sort((a,b)=>b.start.localeCompare(a.start)||(b.dep||"").localeCompare(a.dep||""));
  const groups={};yt.forEach(t=>{(groups[t.start.slice(0,7)]=groups[t.start.slice(0,7)]||[]).push(t)});
  const keys=Object.keys(groups).sort().reverse();
  let days=0,vma=0,open=0;
  yt.forEach(t=>{const c=calc(t);days+=c.days;vma+=c.vma});
  keys.forEach(k=>{if((months[k]?.status||"offen")!=="abgeschickt")open++});
  $("sDays").textContent=days;$("sOpen").textContent=open;$("sVma").textContent=Math.round(vma)+" €";
  renderBackupState();renderLive();
  const list=$("list");
  if(!keys.length){
    list.innerHTML=`<div class="empty"><span class="eyebrow">Noch keine Reisen in ${esc(state.year)}</span>
      <p>Trag jede Dienstreise direkt ein, wenn sie passiert: Ort, Abfahrt, Rückkehr, Hotel und Belege. Am Monatsende steht hier deine fertige Monatsabrechnung mit allen Abschnitten.</p>
      <button class="btn primary" data-act="add">+ Erste Reise erfassen</button></div>`;
    return;
  }
  list.innerHTML=keys.map(k=>{
    const [y,m]=k.split("-"), ts=groups[k], st=months[k]?.status||"offen";
    const mDays=ts.reduce((a,t)=>a+calc(t).days,0), mV=ts.reduce((a,t)=>a+calc(t).vma,0);
    return `<section class="month" style="margin-bottom:16px">
      <div class="month-head">
        <div class="month-title"><h2>${MONTHS[+m-1]} ${y}</h2>
          <small>Abrechnung · ${ts.length} ${ts.length===1?"Abschnitt":"Abschnitte"} · ${mDays} Reisetage</small></div>
        <div class="month-actions">
          <button class="status" data-s="${st}" data-act="status" data-k="${k}" title="Status weiterschalten">${st==="offen"?"Offen":st==="erfasst"?"Erfasst":"Abgeschickt"}</button>
          <button class="btn small" data-act="copy" data-k="${k}">Kopieren</button>
          ${ts.some(t=>t.receipts?.length)?`<button class="btn small" data-act="receipts" data-k="${k}">Belege (${ts.reduce((a,t)=>a+(t.receipts?.length||0),0)})</button>`:""}
        </div>
      </div>
      ${ts.map(tripRow).join("")}
      <div class="month-foot"><span>Kostenstelle: <span class="mono">${esc([...new Set(ts.map(t=>t.ks).filter(Boolean))].join(" / "))}</span></span>
        <span>Verpflegung ca. <b class="mono">${eur(mV)}</b></span></div>
    </section>`;
  }).join("");
}
function tripRow(t){
  const c=calc(t), multi=t.end&&t.end!==t.start;
  const chips=[(t.ks?`<span class="chip ks">${esc(t.ks.split(" ")[0])}</span>`:""),`<span class="chip">${esc(TRANSPORT[t.transport]||t.transport)}${t.transport==="pkw"&&t.km?` · ${esc(t.km)} km`:""}</span>`];
  if(c.nights) chips.push(`<span class="chip">${c.nights} ${c.nights===1?"Hotelnacht":"Hotelnächte"}${t.hotelReceipt?" · Beleg ✓":""}</span>`);
  if(t.breakfasts>0) chips.push(`<span class="chip">${t.breakfasts}× Frühstück</span>`);
  if(t.receipts?.length) chips.push(`<span class="chip">${t.receipts.length} ${t.receipts.length===1?"Beleg":"Belege"}${rcSum(t.receipts)?" · "+eur(rcSum(t.receipts)):""}</span>`);
  return `<article class="trip">
    <div class="date"><span class="w">${WD[pd(t.start).getDay()]}</span><span class="d">${fmtD(t.start).slice(0,2)}</span>${multi?`<span class="to">–${fmtD(t.end).slice(0,2)}</span>`:""}</div>
    <div class="trip-main">
      <h3>${esc(t.place||"Ohne Ort")}${t.purpose?` <span style="font-weight:400;color:var(--muted)">· ${esc(t.purpose)}</span>`:""}</h3>
      <div class="times mono">${fmtD(t.start)} ${esc(t.dep||"--:--")} → ${fmtD(t.end||t.start)} ${esc(t.ret||"--:--")}</div>
      ${t.route?.length?`<div class="times">${t.id===meta.activeTrip?'<span class="dot"></span>':''}Route: ${esc(routeText(t))}</div>`:""}
      <div class="chips">${chips.join("")}</div>
      ${t.note?`<div class="note">${esc(t.note)}</div>`:""}
    </div>
    <div class="trip-side">
      <div style="text-align:right"><div class="vma">${eur(c.vma)}</div><div class="vma-l">Verpflegung</div></div>
      <div class="row-actions"><button class="btn ghost small" data-act="edit" data-id="${t.id}">Bearbeiten</button></div>
    </div></article>`;
}
function monthText(k){
  const [y,m]=k.split("-");
  const ts=trips.filter(t=>t.start?.startsWith(k)).sort((a,b)=>a.start.localeCompare(b.start));
  const ks=[...new Set(ts.map(t=>t.ks).filter(Boolean))];
  let out=`Reisekostenabrechnung ${MONTHS[+m-1]} ${y}\nKostenstelle: ${ks.join(" / ")}\n`;
  ts.forEach((t,i)=>{const c=calc(t);
    out+=`\nAbschnitt ${i+1}: ${WD[pd(t.start).getDay()]} ${fmtD(t.start)} ${t.dep||""} – ${WD[pd(t.end||t.start).getDay()]} ${fmtD(t.end||t.start)} ${t.ret||""}\n`;
    out+=`  Ort: ${t.place||"–"}${t.purpose?" · "+t.purpose:""}\n`;
    if(t.route?.length>1) out+=`  Route: ${routeText(t)}\n`;
    out+=`  Verkehrsmittel: ${TRANSPORT[t.transport]||t.transport}${t.transport==="pkw"&&t.km?` (${t.km} km)`:""}\n`;
    if(c.nights) out+=`  Übernachtung: ${c.nights} Nacht/Nächte, Hotelrechnung liegt vor\n`;
    if(t.breakfasts>0||t.meals>0) out+=`  Gestellte Mahlzeiten: ${t.breakfasts||0}× Frühstück, ${t.meals||0}× Mittag/Abend\n`;
    (t.receipts||[]).forEach(r=>{out+=`  Beleg: ${r.kind||"Beleg"}${r.vendor?" ("+r.vendor+")":""}${r.date?" vom "+fmtD(r.date):""}${r.amount?" · "+eur(Number(r.amount)):""}\n`});
    if(ks.length>1) out+=`  Kostenstelle: ${t.ks}\n`;
  });
  return out;
}

/* ================= Sicherung ================= */
function backupReason(){
  if(!trips.length) return null;
  if(!meta.lastBackup) return "Du hast noch keine Sicherung. Die Daten liegen nur auf diesem Gerät.";
  const last=new Date(meta.lastBackup), now=new Date();
  const changed=(meta.lastChange||0)>last.getTime();
  if(!changed) return null;
  if(last.getMonth()!==now.getMonth()||last.getFullYear()!==now.getFullYear()) return "Neuer Monat: sichere den Stand vom letzten Monat.";
  const d=Math.floor((now-last)/864e5);
  if(d>=BACKUP_DAYS) return `Letzte Sicherung vor ${d} Tagen. Seitdem hast du etwas geändert.`;
  return null;
}
function renderBackupState(){
  const why=backupReason();
  $("backupBanner").hidden=!why; if(why) $("backupWhy").textContent=why;
  $("backupMeta").textContent=meta.lastBackup?"Letzte Sicherung: "+new Date(meta.lastBackup).toLocaleDateString("de-DE",{day:"2-digit",month:"2-digit",year:"numeric"}):"Noch keine Sicherung";
}
async function markChanged(){meta.lastChange=Date.now();await saveMeta()}
const b64=blob=>new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(String(r.result).split(",")[1]);r.onerror=no;r.readAsDataURL(blob)});
async function shareOrDownload(file){
  if(navigator.canShare&&navigator.canShare({files:[file]})){
    try{await navigator.share({files:[file],title:file.name});return true}
    catch(e){if(e&&e.name==="AbortError")return false}
  }
  const a=document.createElement("a");a.href=URL.createObjectURL(file);a.download=file.name;document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove()},4000);return true;
}
function extOf(name,type){const m=(name||"").match(/\.([a-z0-9]{2,5})$/i);if(m)return m[1].toLowerCase();
  return {"image/jpeg":"jpg","image/png":"png","image/heic":"heic","image/heif":"heif","application/pdf":"pdf"}[type]||"bin"}
const safe=s=>String(s||"").normalize("NFC").replace(/[\/\\:*?"<>|]/g,"").replace(/\s+/g,"-").slice(0,40);
function receiptName(r,t,n){
  const d=r.date||t.start, amt=r.amount?String(Number(r.amount).toFixed(2)).replace(".",",")+"EUR":"";
  return [d,safe(r.kind||"Beleg"),amt,safe(r.vendor||t.place)].filter(Boolean).join("_")+(n>1?"_"+n:"")+"."+(r.ext||extOf(r.name,r.type));
}
let zipP=null;
function loadZip(){if(window.JSZip)return Promise.resolve(window.JSZip);if(zipP)return zipP;
  zipP=new Promise((ok,no)=>{const s=document.createElement("script");s.src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";s.onload=()=>ok(window.JSZip);s.onerror=()=>{zipP=null;no(new Error("load"))};document.head.appendChild(s)});return zipP}
async function monthFiles(k){
  const out=[],used={};
  for(const t of trips.filter(t=>t.start?.startsWith(k)).sort((a,b)=>a.start.localeCompare(b.start))){
    for(const r of t.receipts||[]){const f=await dbGet("files",r.id);if(!f)continue;
      let n=receiptName(r,t,0);if(used[n]){used[n]++;n=receiptName(r,t,used[n])}else used[n]=1;
      out.push(new File([f.blob],n,{type:f.type}))}}
  return out;
}
async function shareReceipts(k){
  const files=await monthFiles(k);if(!files.length){toast("Keine Belege in diesem Monat");return}
  if(navigator.canShare&&navigator.canShare({files})){
    try{await navigator.share({files,title:"Belege "+k});return}catch(e){if(e&&e.name==="AbortError")return}
  }
  const Z=await loadZip(),z=new Z();files.forEach(f=>z.file(f.name,f));
  await shareOrDownload(new File([await z.generateAsync({type:"blob"})],`Belege-${k}.zip`,{type:"application/zip"}));
}
async function backup(){
  toast("Sicherung wird erstellt …");
  const Z=await loadZip(),z=new Z();
  const files=await dbAll("files");
  z.file("daten.json",JSON.stringify({app:"reiselogbuch",version:2,exportedAt:new Date().toISOString(),trips,months,
    files:files.map(f=>({id:f.id,type:f.type,name:f.name||""}))}));
  files.forEach(f=>{z.file("intern/"+f.id,f.blob);if(f.thumb)z.file("intern/"+f.id+".vorschau.jpg",f.thumb)});
  // lesbare Kopie der Originale, nach Monat sortiert
  const used={};
  trips.forEach(t=>(t.receipts||[]).forEach(r=>{const f=files.find(x=>x.id===r.id);if(!f)return;
    let n=receiptName(r,t,0),key=t.start.slice(0,7)+"/"+n;if(used[key]){used[key]++;n=receiptName(r,t,used[key])}else used[key]=1;
    z.file("Belege/"+t.start.slice(0,7)+"/"+n,f.blob)}));
  const blob=await z.generateAsync({type:"blob"});
  const name=`Reiselogbuch-Sicherung-${iso(new Date())}.zip`;
  const ok=await shareOrDownload(new File([blob],name,{type:"application/zip"}));
  if(ok){meta.lastBackup=new Date().toISOString();await saveMeta();render();toast("Sicherung gespeichert")}
}
async function restore(file){
  let data,zip=null;
  try{
    if(/\.zip$/i.test(file.name)||file.type.includes("zip")){const Z=await loadZip();zip=await Z.loadAsync(file);data=JSON.parse(await zip.file("daten.json").async("string"))}
    else data=JSON.parse(await file.text());
  }catch(e){toast("Die Datei ist keine gültige Sicherung.");return}
  if(data?.app!=="reiselogbuch"){toast("Die Datei ist keine Reise-Logbuch-Sicherung.");return}
  const host=$("sheetHost");
  host.innerHTML=`<div class="backdrop" id="bdR"><div class="sheet confirm"><h2>Sicherung laden?</h2>
    <p>Sicherung vom ${new Date(data.exportedAt).toLocaleDateString("de-DE")} mit ${data.trips.length} Reisen und ${data.files.length} Belegen. Reisen mit gleicher Kennung werden durch die Sicherung ersetzt, alle anderen bleiben erhalten.</p>
    <div class="sheet-actions"><button class="btn" id="rNo">Abbrechen</button><button class="btn primary" id="rYes">Laden</button></div></div></div>`;
  $("rNo").onclick=()=>host.innerHTML="";
  $("rYes").onclick=async()=>{
    for(const f of data.files){let blob;
      if(zip){const e=zip.file("intern/"+f.id);if(!e)continue;blob=new Blob([await e.async("arraybuffer")],{type:f.type})}
      else{const bin=atob(f.data),arr=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);blob=new Blob([arr],{type:f.type})}
      let thumb=null;const te=zip&&zip.file("intern/"+f.id+".vorschau.jpg");
      if(te)thumb=new Blob([await te.async("arraybuffer")],{type:"image/jpeg"});
      else if(f.type.startsWith("image/")){try{thumb=await prepImage(blob,900,false)}catch(e){}}
      await dbPut("files",{id:f.id,type:f.type,name:f.name||"",blob,thumb})}
    for(const t of data.trips) await dbPut("trips",t);
    months={...months,...(data.months||{})};await dbPut("meta",months,"months");
    await loadAll();host.innerHTML="";render();toast("Sicherung geladen");
  };
}
async function exportCsv(){
  const rows=[["Abreise","Abfahrt","Rückreise","Ankunft","Ort","Anlass","Verkehrsmittel","km","Nächte","Frühstück gestellt","Mahlzeiten gestellt","Kostenstelle","Belege","Belege Summe €","Verpflegung ca. €","Status Monat","Notiz"]];
  trips.filter(t=>t.start?.startsWith(state.year)).sort((a,b)=>a.start.localeCompare(b.start)).forEach(t=>{const c=calc(t);
    rows.push([fmtD(t.start)+t.start.slice(0,4),t.dep||"",fmtD(t.end||t.start)+(t.end||t.start).slice(0,4),t.ret||"",t.place,t.purpose,TRANSPORT[t.transport]||t.transport,t.km||"",c.nights,t.breakfasts||0,t.meals||0,t.ks,
      (t.receipts||[]).map(r=>(r.kind||"Beleg")+(r.amount?" "+String(r.amount).replace(".",","):"")).join(", "),rcSum(t.receipts).toFixed(2).replace(".",","),c.vma.toFixed(2).replace(".",","),months[t.start.slice(0,7)]?.status||"offen",t.note||""])});
  const csv="﻿"+rows.map(r=>r.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(";")).join("\r\n");
  await shareOrDownload(new File([csv],`Reisen-${state.year}.csv`,{type:"text/csv"}));
}

/* ================= Formular ================= */
const urlCache=new Map();
async function fileUrl(id,thumb){const key=id+(thumb?":t":"");if(urlCache.has(key))return urlCache.get(key);const f=await dbGet("files",id);if(!f)return null;const u=URL.createObjectURL(thumb&&f.thumb?f.thumb:f.blob);urlCache.set(key,u);return u}
async function showFile(id,type){
  const f=await dbGet("files",id);if(!f){toast("Beleg nicht gefunden");return}
  const u=await fileUrl(id), pv=f.thumb?await fileUrl(id,true):(type||"").startsWith("image/")?u:null;
  if(!pv){window.open(u,"_blank");return}
  const v=document.createElement("div");v.className="viewer";
  v.innerHTML=`<img src="${pv}" alt="Beleg"><div style="display:flex;gap:8px">${f.type==="application/pdf"?`<a class="btn" href="${u}" target="_blank" rel="noopener">PDF öffnen</a>`:""}<button class="btn primary" id="vClose">Schließen</button></div>`;
  v.addEventListener("click",e=>{if(e.target===v||e.target.id==="vClose")v.remove()});document.body.appendChild(v);
}
function openSheet(t){
  const isNew=!t, today=iso(new Date());
  t=t||{id:"t"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),start:today,end:today,dep:"07:00",ret:"18:00",place:"",purpose:"",transport:"bahn",km:"",breakfasts:0,meals:0,hotelReceipt:false,note:"",receipts:[]};
  const host=$("sheetHost");
  host.innerHTML=`<div class="backdrop" id="bd"><form class="sheet" id="f" novalidate>
    <h2>${isNew?"Reise erfassen":"Reise bearbeiten"}</h2>
    <div class="field"><label for="f_place">Ort</label><div style="display:flex;gap:6px"><input id="f_place" required placeholder="z. B. Hamburg" value="${esc(t.place)}"><button type="button" class="btn small" id="f_here" style="white-space:nowrap">Hier</button></div>${t.route?.length?`<span class="hint">Route: ${esc(routeText(t))}</span>`:""}</div>
    <div class="field"><label for="f_purpose">Anlass</label><input id="f_purpose" placeholder="z. B. Kundentermin" value="${esc(t.purpose)}"></div>
    <div class="grid2">
      <div class="field"><label for="f_start">Abreise</label><input type="date" id="f_start" value="${t.start}"></div>
      <div class="field"><label for="f_dep">Abfahrt Wohnung</label><input type="time" id="f_dep" value="${esc(t.dep)}"></div>
      <div class="field"><label for="f_end">Rückreise</label><input type="date" id="f_end" value="${t.end||t.start}"></div>
      <div class="field"><label for="f_ret">Ankunft Wohnung</label><input type="time" id="f_ret" value="${esc(t.ret)}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="f_tr">Verkehrsmittel</label><select id="f_tr">${Object.entries(TRANSPORT).map(([k,v])=>`<option value="${k}" ${k===t.transport?"selected":""}>${v}</option>`).join("")}</select></div>
      <div class="field" id="kmField" ${t.transport==="pkw"?"":"hidden"}><label for="f_km">Gefahrene km</label><input type="number" min="0" inputmode="numeric" id="f_km" value="${esc(t.km)}"></div>
    </div>
    <div class="grid2">
      <div class="field"><label for="f_bf">Frühstück im Hotel</label><input type="number" min="0" inputmode="numeric" id="f_bf" value="${t.breakfasts||0}"></div>
      <div class="field"><label for="f_ml">Gestellte Mittag-/Abendessen</label><input type="number" min="0" inputmode="numeric" id="f_ml" value="${t.meals||0}"></div>
    </div>
    <label class="hint" style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="f_hr" ${t.hotelReceipt?"checked":""}> Hotelrechnung liegt vor</label>
    <div class="field">
      <div class="rc-head"><span class="field-l">Belege</span>
        <div class="scanbtns">
          <label class="btn small primary" for="f_cam">Beleg scannen<input type="file" id="f_cam" accept="image/*" capture="environment"></label>
          <label class="btn small" for="f_file">Datei / PDF<input type="file" id="f_file" accept="image/*,application/pdf" multiple></label>
        </div></div>
      <div class="receipts" id="rcList"></div>
      <span class="hint">Fotos werden als PDF gespeichert und nebenbei ausgelesen. Für sauber zugeschnittene Scans: in der Dateien-App „Dokumente scannen“ und hier über „Datei / PDF“ hinzufügen.</span>
    </div>
    <div class="ksbox"><label for="f_ks">Kostenstelle</label><input id="f_ks" class="mono" style="flex:1;min-width:0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 8px" placeholder="einmal eintragen, wird gemerkt" value="${esc(t.ks||defaultKS())}"></div>
    <div class="field"><label for="f_note">Notiz</label><textarea id="f_note" placeholder="z. B. Zug verspätet, Taxi selbst bezahlt">${esc(t.note)}</textarea></div>
    <div class="calc" id="calc"></div>
    <div class="sheet-actions">
      ${isNew?"":`<button type="button" class="btn danger" id="del">Löschen</button>`}
      <span style="flex:1"></span>
      <button type="button" class="btn" id="cancel">Abbrechen</button>
      <button type="submit" class="btn primary">Speichern</button>
    </div></form></div>`;
  const g=id=>$(id);
  const orig=(t.receipts||[]).map(r=>r.id);
  let rcs=(t.receipts||[]).map(r=>({...r}));
  const fresh=new Set(); let busy=0;
  const upd=()=>{const c=calc(read());g("calc").innerHTML=`${c.days} ${c.days===1?"Reisetag":"Reisetage"} · ${c.nights} ${c.nights===1?"Nacht":"Nächte"} · Verpflegung ca. <b>${eur(c.vma)}</b> <span>(Inland 14 €/28 €, abzgl. gestellter Mahlzeiten; verbindlich ist dein Abrechnungssystem)</span>`};
  const drawRc=async()=>{
    const html=await Promise.all(rcs.map(async(r,i)=>{
      const isImg=(r.type||"").startsWith("image/")||r.hasThumb;const u=r.pending?null:await fileUrl(r.id,true);
      return `<div class="rc">
        <button type="button" class="thumb" data-view="${i}" aria-label="Beleg ansehen" style="border:none;cursor:pointer">${r.pending?"…":isImg&&u?`<img src="${u}" alt="">`:"PDF"}</button>
        <div class="rc-fields">
          <select class="rc-kind" data-i="${i}" data-k="kind" aria-label="Belegart"><option value="" ${r.kind?"":"selected"}>Art wählen …</option>${KINDS.map(k=>`<option ${k===r.kind?"selected":""}>${k}</option>`).join("")}</select>
          <input data-i="${i}" data-k="amount" inputmode="decimal" placeholder="Betrag €" aria-label="Betrag" value="${r.amount!=null&&r.amount!==""?esc(String(r.amount).replace(".",",")):""}">
          <input type="date" data-i="${i}" data-k="date" aria-label="Belegdatum" value="${esc(r.date||"")}">
          <div class="rc-meta ${r.pending||r.reading?"busy":""}">${r.pending?"Wird gespeichert …":r.reading?`Wird ausgelesen … ${r.progress?r.progress+" %":""}`:esc(r.vendor||r.name||"Beleg")}${r.error?" · "+esc(r.error):""}</div>
        </div>
        <button type="button" class="btn ghost small" data-rm="${i}" aria-label="Beleg entfernen">Entfernen</button></div>`}));
    g("rcList").innerHTML=html.join("");
  };
  g("rcList").addEventListener("input",e=>{const el=e.target,i=+el.dataset.i,k=el.dataset.k;if(!k)return;
    rcs[i][k]=k==="amount"?(el.value.trim()===""?"":(Number(el.value.replace(/\./g,"").replace(",","."))||el.value)):el.value;
    if(k==="kind"&&el.value==="Hotel")g("f_hr").checked=true;});
  g("rcList").addEventListener("click",e=>{
    const v=e.target.closest("[data-view]");if(v){const r=rcs[+v.dataset.view];if(r&&!r.pending)showFile(r.id,r.type);return}
    const b=e.target.closest("[data-rm]");if(!b)return;
    const r=rcs.splice(+b.dataset.rm,1)[0];
    if(r&&fresh.has(r.id)){dbDel("files",r.id).catch(()=>{});fresh.delete(r.id)}
    drawRc();upd();});
  let lastProg=0;
  async function addFiles(files){
    for(const file of files){
      const tmp={id:"f"+Date.now().toString(36)+Math.random().toString(36).slice(2,7),pending:true,name:file.name,type:file.type,kind:"",amount:"",date:""};
      rcs.push(tmp);drawRc();busy++;
      try{
        // Fotos werden zum PDF, hochgeladene PDFs bleiben unverändert; Vorschau separat
        const isImgIn=(file.type||"").startsWith("image/");
        let blob=file,type=file.type||(/\.pdf$/i.test(file.name)?"application/pdf":"application/octet-stream"),thumb=null;
        if(isImgIn){
          try{thumb=await prepImage(file,900,false)}catch(e){}
          try{blob=await photoToPdf(file);type="application/pdf"}
          catch(e){toast(navigator.onLine?"PDF-Umwandlung fehlgeschlagen, Foto wird gespeichert":"PDF braucht beim ersten Mal Internet, Foto wird gespeichert")}
        }
        await dbPut("files",{id:tmp.id,type,name:file.name||"",blob,thumb});
        Object.assign(tmp,{type,ext:extOf(type==="application/pdf"?"":file.name,type),hasThumb:!!thumb,pending:false});fresh.add(tmp.id);
        if(isImgIn){
          tmp.reading=true;drawRc();
          try{
            const x=await ocr(file,p=>{tmp.progress=p;if(p-lastProg>=20||p===100){lastProg=p;drawRc()}});
            if(x.amount!=null)tmp.amount=x.amount;if(x.date)tmp.date=x.date;if(x.vendor)tmp.vendor=x.vendor;
            if(x.amount==null||!x.date)tmp.error="Nicht alles erkannt, bitte ergänzen";
          }catch(err){tmp.error=navigator.onLine?"Nicht automatisch lesbar, bitte selbst eintragen":"Texterkennung braucht beim ersten Mal Internet"}
          tmp.reading=false;lastProg=0;
        }
      }catch(err){
        const idx=rcs.indexOf(tmp);if(idx>=0)rcs.splice(idx,1);
        toast("Beleg konnte nicht gespeichert werden. Ist der Speicher voll?");
      }
      busy--;drawRc();upd();
    }
  }
  ["f_cam","f_file"].forEach(id=>{const inp=g(id);inp.addEventListener("change",()=>{if(inp.files?.length)addFiles([...inp.files]);inp.value=""})});
  function read(){const st=g("f_start").value;return {...t,receipts:rcs.filter(r=>!r.pending).map(({pending,reading,error,progress,...r})=>r),
    place:g("f_place").value.trim(),purpose:g("f_purpose").value.trim(),start:st,end:g("f_end").value<st?st:g("f_end").value,dep:g("f_dep").value,ret:g("f_ret").value,
    transport:g("f_tr").value,km:g("f_km").value,breakfasts:+g("f_bf").value||0,meals:+g("f_ml").value||0,hotelReceipt:g("f_hr").checked,note:g("f_note").value.trim(),ks:g("f_ks").value.trim()}}
  g("f_start").addEventListener("change",()=>{if(g("f_end").value<g("f_start").value)g("f_end").value=g("f_start").value;upd()});
  g("f_here").onclick=async()=>{const b=g("f_here");b.textContent="…";const p=await getPos();const n=p?await placeName(p.lat,p.lon):null;b.textContent="Hier";if(n){g("f_place").value=cityOnly(n)}else toast(p?"Ort nicht gefunden, bitte eintippen":"Standort nicht verfügbar")};
  g("f_tr").addEventListener("change",()=>{g("kmField").hidden=g("f_tr").value!=="pkw"});
  g("f").addEventListener("input",upd);drawRc();upd();
  const close=()=>host.innerHTML="";
  const discard=()=>{fresh.forEach(id=>dbDel("files",id).catch(()=>{}));close()};
  g("cancel").onclick=discard;
  g("bd").addEventListener("click",e=>{if(e.target.id==="bd")discard()});
  if(!isNew){const d=g("del");d.onclick=async()=>{
    if(!d.dataset.sure){d.dataset.sure="1";d.textContent="Wirklich löschen?";return}
    await dbDel("trips",t.id);for(const id of [...orig,...fresh])await dbDel("files",id).catch(()=>{});
    trips=trips.filter(x=>x.id!==t.id);if(meta.activeTrip===t.id)meta.activeTrip=null;await markChanged();close();render();toast("Reise gelöscht")}}
  g("f").addEventListener("submit",async e=>{e.preventDefault();const n=read();
    if(busy){toast("Beleg wird noch verarbeitet …");return}
    try{
      await dbPut("trips",n);
      if(n.ks&&n.ks!==meta.ks){meta.ks=n.ks;await saveMeta()}
      const keep=new Set(n.receipts.map(r=>r.id));for(const id of orig)if(!keep.has(id))await dbDel("files",id).catch(()=>{});
      const i=trips.findIndex(x=>x.id===n.id);if(i>=0)trips[i]=n;else trips.push(n);
      await markChanged();state.year=n.start.slice(0,4);close();render();toast("Gespeichert");
    }catch(err){toast("Speichern fehlgeschlagen. Bitte nochmal versuchen.")}
  });
}

/* ================= Beleg direkt an laufende Reise ================= */
async function quickAttach(file){
  const t=trips.find(x=>x.id===meta.activeTrip);if(!t){toast("Keine laufende Reise");return}
  toast("Beleg wird gespeichert …");
  logPassive(true).catch(()=>{});
  const id="f"+Date.now().toString(36)+Math.random().toString(36).slice(2,7);
  const isImg=(file.type||"").startsWith("image/");
  let blob=file,type=file.type||(/\.pdf$/i.test(file.name)?"application/pdf":"application/octet-stream"),thumb=null;
  if(isImg){
    try{thumb=await prepImage(file,900,false)}catch(e){}
    try{blob=await photoToPdf(file);type="application/pdf"}catch(e){}
  }
  try{await dbPut("files",{id,type,name:file.name||"",blob,thumb})}
  catch(e){toast("Beleg konnte nicht gespeichert werden. Ist der Speicher voll?");return}
  const r={id,type,ext:extOf(type==="application/pdf"?"":file.name,type),hasThumb:!!thumb,name:file.name||"",kind:"",amount:"",date:""};
  t.receipts=[...(t.receipts||[]),r];
  await dbPut("trips",t);await markChanged();render();
  if(!isImg){toast("Beleg angehängt");return}
  toast("Beleg angehängt, wird ausgelesen …");
  try{
    const x=await ocr(file);
    const cur=trips.find(y=>y.id===t.id);const rr=cur&&(cur.receipts||[]).find(y=>y.id===id);if(!rr)return;
    if(x.amount!=null)rr.amount=x.amount;if(x.date)rr.date=x.date;if(x.vendor)rr.vendor=x.vendor;
    await dbPut("trips",cur);await markChanged();render();
    toast(`Beleg angehängt${rr.amount?" · "+eur(Number(rr.amount)):""}`);
  }catch(e){toast("Beleg angehängt. Betrag bitte später unter „Bearbeiten“ prüfen.")}
}

/* ================= Events ================= */
document.addEventListener("click",async e=>{
  const b=e.target.closest("[data-act]");if(!b)return;
  const a=b.dataset.act;
  if(a==="add")openSheet();
  if(a==="scan"){$("quickCam").click()}
  if(a==="go"||a==="arrive"||a==="home"){b.disabled=true;await logStop({go:"start",arrive:"ziel",home:"ende"}[a]).catch(()=>toast("Konnte nicht speichern"));b.disabled=false}
  if(a==="edit")openSheet(trips.find(t=>t.id===b.dataset.id));
  if(a==="backup")backup().catch(()=>toast("Sicherung fehlgeschlagen"));
  if(a==="receipts"){b.disabled=true;await shareReceipts(b.dataset.k).catch(()=>toast("Belege konnten nicht exportiert werden"));b.disabled=false}
  if(a==="csv")exportCsv().catch(()=>toast("Export fehlgeschlagen"));
  if(a==="status"){const k=b.dataset.k,cur=months[k]?.status||"offen",nx={offen:"erfasst",erfasst:"abgeschickt",abgeschickt:"offen"}[cur];
    months[k]={status:nx};await dbPut("meta",months,"months");await markChanged();render();}
  if(a==="copy"){const txt=monthText(b.dataset.k);
    try{await navigator.clipboard.writeText(txt);toast("Kopiert")}
    catch(err){const host=$("sheetHost");host.innerHTML=`<div class="backdrop"><div class="sheet"><h2>Text zum Einfügen</h2><textarea class="mono" style="min-height:260px;width:100%;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:13px" id="cpy">${esc(txt)}</textarea><div class="sheet-actions"><button class="btn primary" id="cl2">Fertig</button></div></div></div>`;
      $("cpy").select();$("cl2").onclick=()=>host.innerHTML="";}}
});
$("addTop").onclick=()=>openSheet();$("addFab").onclick=()=>openSheet();
$("yearSel").onchange=e=>{state.year=e.target.value;render()};
(()=>{const q=document.createElement("input");q.type="file";q.id="quickCam";q.accept="image/*";q.setAttribute("capture","environment");q.hidden=true;document.body.appendChild(q);
  q.addEventListener("change",async()=>{const fs=[...(q.files||[])];q.value="";for(const f of fs)await quickAttach(f)})})();
$("restoreInp").addEventListener("change",e=>{const f=e.target.files?.[0];if(f)restore(f);e.target.value=""});

/* ================= Start ================= */
(async()=>{
  try{await loadAll()}catch(e){toast("Speicher nicht verfügbar. Im privaten Modus funktioniert die App nicht.")}
  render();
  try{if(navigator.storage?.persist)await navigator.storage.persist()}catch(e){}
  if("serviceWorker" in navigator&&location.protocol==="https:")navigator.serviceWorker.register("sw.js").catch(()=>{});
  logPassive().catch(()=>{});
  document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")logPassive().catch(()=>{})});
})();
window.__reiselog={calc,parseReceipt,defaultKS};
})();
