"use strict";

const STORE_KEY = "kraxen-bible-plan-progress-v1";
const APP_ID = "kraxen-2-year-bible-plan";
const partId = Number(document.body.dataset.part);
const root = document.getElementById("content");
const totalCount = document.getElementById("total-count");
const totalBar = document.getElementById("total-bar");
const partCount = document.getElementById("part-count");
const partBar = document.getElementById("part-bar");
const status = document.getElementById("save-status");
const jumpButton = document.getElementById("jump");
const fileInput = document.getElementById("import-file");
const toast = document.getElementById("toast");

let plan;
let readings;
let progress = new Set();
let previousProgress = null;
let lastToastTimer = null;
const pad = number => String(number).padStart(2, "0");
const numDate = date => {
  const [year,month,day] = date.split("-");
  return Number(day) + ". " + Number(month) + ". " + year;
};
const range = (start,end) => numDate(start) + " až " + numDate(end);
const escapeHTML = value => String(value).replace(/[&<>"']/g, ch =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
const firstIncomplete = () => readings.find(r => !progress.has(r.id));
const allIn = ids => ids.every(id => progress.has(id));
const checkedIn = ids => ids.reduce((total,id) => total + Number(progress.has(id)),0);
const monthReadings = month => month.weeks.flatMap(week => week.readings);
const monthIds = month => monthReadings(month).map(reading => reading.id);
const partIds = part => part.months.flatMap(monthIds);
const weekIds = week => week.readings.map(reading => reading.id);

function readLocal() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.completed)) {
      throw new Error("Unsupported saved progress");
    }
    if (!parsed.completed.every(x => Number.isInteger(x) && x >= 1 && x <= plan.assignments)) {
      throw new Error("Invalid saved progress");
    }
    return new Set(parsed.completed);
  } catch (error) {
    status.textContent = "Uložený stav sa nepodarilo načítať";
    status.classList.add("error");
    status.hidden = false;
    return new Set();
  }
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY,JSON.stringify({version:1,completed:[...progress].sort((a,b)=>a-b)}));
    status.textContent = "Uložené v tomto prehliadači";
    status.classList.remove("error");
    status.hidden = true;
    return true;
  } catch (error) {
    status.textContent = "Chyba ukladania. Exportuj zálohu.";
    status.classList.add("error");
    status.hidden = false;
    return false;
  }
}

function showToast(message,undo=false) {
  toast.replaceChildren();
  const span=document.createElement("span");
  span.textContent=message;
  toast.append(span);
  if(undo) {
    const button=document.createElement("button");
    button.type="button";
    button.textContent="Späť";
    button.addEventListener("click",()=>{
      if(!previousProgress) return;
      progress = previousProgress;
      previousProgress=null;
      persist();
      refresh();
      hideToast();
    });
    toast.append(button);
  }
  toast.hidden=false;
  clearTimeout(lastToastTimer);
  lastToastTimer=setTimeout(hideToast,5000);
}
function hideToast() { toast.hidden=true; }

function setChecked(ids,value,label) {
  previousProgress=new Set(progress);
  ids.forEach(id=>value?progress.add(id):progress.delete(id));
  if(!persist()) {
    // Keep the visible state consistent with what can actually be recovered.
    progress=previousProgress;
    previousProgress=null;
    refresh();
    showToast("Zmeny sa nepodarilo uložiť");
    return;
  }
  refresh();
  if(ids.length>1) showToast(label + (value?" označené":" odznačené"),true);
  else hideToast();
}

function sectionCheckbox(type,id,ids,label) {
  const check=document.createElement("input");
  check.type="checkbox";
  check.className="check scope-check";
  check.setAttribute("aria-label",label);
  check.dataset.type=type;
  check.dataset.id=String(id);
  check.dataset.ids=ids.join(",");
  return check;
}

function monthNode(month) {
  const node=document.createElement("section");
  node.className="month";
  node.id="month-"+month.id;
  const header=document.createElement("div");
  header.className="month-header";
  const ids=monthIds(month);
  header.append(sectionCheckbox("month",month.id,ids,"Označiť celý mesiac "+month.id));
  const heading=document.createElement("div");
  heading.className="month-heading";
  heading.innerHTML='<span class="month-title">Mesiac '+pad(month.id)+'</span><span class="month-date">'+escapeHTML(range(month.start,month.end))+'</span>';
  const tally=document.createElement("span");
  tally.className="section-count";
  tally.dataset.countIds=ids.join(",");
  header.append(heading,tally);
  node.append(header);
  const body=document.createElement("div");
  body.className="month-body";
  body.id="month-body-"+month.id;
  for(const week of month.weeks) body.append(weekNode(week));
  node.append(body);
  return node;
}

function weekNode(week) {
  const node=document.createElement("section");
  node.className="week";
  node.id="week-"+week.id;
  const heading=document.createElement("div");
  heading.className="week-header";
  const ids=weekIds(week);
  heading.append(sectionCheckbox("week",week.id,ids,"Označiť celý týždeň "+week.id));
  const label=document.createElement("div");
  label.className="week-name";
  const title=document.createElement("h3");
  title.textContent="Týždeň "+pad(week.id);
  const date=document.createElement("strong");
  date.className="week-date";
  date.textContent=range(week.start,week.end);
  label.append(title,date);
  const tally=document.createElement("span");
  tally.className="section-count";
  tally.dataset.countIds=ids.join(",");
  heading.append(label,tally);
  node.append(heading);
  const note=document.createElement("blockquote");
  note.className="week-note";
  note.textContent=week.note;
  node.append(note);
  const list=document.createElement("div");
  list.className="readings";
  for(const reading of week.readings) {
    const row=document.createElement("label");
    row.className="reading";
    row.id="reading-"+reading.id;
    const input=document.createElement("input");
    input.type="checkbox";
    input.className="check reading-check";
    input.dataset.type="reading";
    input.dataset.id=String(reading.id);
    const text=document.createElement("span");
    text.className="reading-ref";
    text.textContent=reading.reference;
    row.append(input,text);
    list.append(row);
  }
  node.append(list);
  return node;
}

function render() {
  const part=plan.parts[partId-1];
  const ids=partIds(part);
  document.getElementById("period").textContent=range(part.months[0].start,part.months.at(-1).end);
  document.getElementById("part-title").textContent="Časť "+partId+" zo 4";
  document.getElementById("part-checkbox-wrap").replaceChildren(
    sectionCheckbox("part",partId,ids,"Označiť celú časť "+partId)
  );
  root.replaceChildren(...part.months.map(monthNode));
  refresh();
}

function refresh() {
  const part=plan.parts[partId-1];
  const pids=partIds(part);
  const done=progress.size;
  totalCount.textContent=done+" / "+plan.assignments;
  partCount.textContent=checkedIn(pids)+" / "+pids.length;
  totalBar.style.width=100*done/plan.assignments+"%";
  partBar.style.width=100*checkedIn(pids)/pids.length+"%";
  for(const checkbox of document.querySelectorAll("input.check")) {
    if(checkbox.dataset.type==="reading") {
      checkbox.checked=progress.has(Number(checkbox.dataset.id));
    } else {
      const ids=checkbox.dataset.ids.split(",").map(Number);
      const count=checkedIn(ids);
      checkbox.checked=count===ids.length;
      checkbox.indeterminate=count>0 && count<ids.length;
      checkbox.title=count+" / "+ids.length;
    }
  }
  for(const span of document.querySelectorAll("[data-count-ids]")) {
    const ids=span.dataset.countIds.split(",").map(Number);
    span.textContent=checkedIn(ids)+"/"+ids.length;
  }
  for(const row of document.querySelectorAll(".reading")) {
    const done=progress.has(Number(row.id.slice(8)));
    row.classList.toggle("done",done);
    row.classList.remove("next");
  }
  const next=firstIncomplete();
  if(next) {
    const nextRow=document.getElementById("reading-"+next.id);
    if(nextRow) nextRow.classList.add("next");
    jumpButton.disabled=false;
    jumpButton.title="Prejsť na čítanie "+next.id;
  } else {
    jumpButton.disabled=true;
    jumpButton.title="Všetky čítania dokončené";
  }
}

function findPosition(readingId) {
  for(const part of plan.parts)
    for(const month of part.months)
      for(const week of month.weeks)
        if(week.readings.some(r=>r.id===readingId))
          return {part:part.id,month:month.id,week:week.id};
  return null;
}
function openAt(readingId) {
  const position=findPosition(readingId);
  if(!position) return;
  if(position.part!==partId) {
    location.href="part-"+position.part+".html#reading-"+readingId;
    return;
  }
  requestAnimationFrame(()=>{
    const target=document.getElementById("reading-"+readingId);
    target?.scrollIntoView({block:"center",behavior:"smooth"});
  });
}
function changeScope(input) {
  if(input.dataset.type==="reading") {
    setChecked([Number(input.dataset.id)],input.checked,"Čítanie");
    return;
  }
  const ids=input.dataset.ids.split(",").map(Number);
  const value=input.checked;
  const name=input.dataset.type==="week"?"Týždeň "+input.dataset.id:
    input.dataset.type==="month"?"Mesiac "+input.dataset.id:"Časť "+input.dataset.id;
  if(input.dataset.type==="part" && !confirm(name+": naozaj chceš "+(value?"označiť":"odznačiť")+" všetky čítania?")) {
    refresh();
    return;
  }
  setChecked(ids,value,name);
}
function exportProgress() {
  const payload={
    app:APP_ID,
    version:1,
    exportedAt:new Date().toISOString(),
    completed:[...progress].sort((a,b)=>a-b)
  };
  const blob=new Blob([JSON.stringify(payload,null,2)+"\n"],{type:"application/json"});
  const link=document.createElement("a");
  const url=URL.createObjectURL(blob);
  link.href=url;
  link.download="bible-reading-progress-"+new Date().toISOString().slice(0,10)+".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  document.getElementById("backup-menu").open=false;
}
async function importProgress(file) {
  if(!file) return;
  try {
    const value=JSON.parse(await file.text());
    if(value?.app!==APP_ID || value?.version!==1 || !Array.isArray(value.completed) ||
      !value.completed.every(x=>Number.isInteger(x)&&x>=1&&x<=plan.assignments) ||
      new Set(value.completed).size!==value.completed.length) {
      throw new Error("Neplatný formát zálohy alebo ID čítania");
    }
    if(!confirm("Import nahradí aktuálny postup ("+progress.size+" čítaní) zálohou ("+
      value.completed.length+" čítaní). Pokračovať?")) return;
    previousProgress=new Set(progress);
    progress=new Set(value.completed);
    if(!persist()) {
      progress=previousProgress;
      previousProgress=null;
      throw new Error("Úložisko nie je dostupné");
    }
    render();
    showToast("Záloha obnovená",true);
  } catch(error) {
    alert("Import zlyhal: "+error.message);
  } finally {
    fileInput.value="";
    document.getElementById("backup-menu").open=false;
  }
}

async function init() {
  try {
    const response=await fetch("./plan.json",{cache:"no-cache"});
    if(!response.ok) throw new Error("HTTP "+response.status);
    plan=await response.json();
    if(plan.version!==1||plan.assignments!==518||plan.parts?.length!==4) throw new Error("Invalid plan data");
    readings=plan.parts.flatMap(part=>part.months.flatMap(month=>month.weeks.flatMap(week=>week.readings)));
    if(readings.length!==518||readings.some((r,i)=>r.id!==i+1)) throw new Error("Invalid reading IDs");
    progress=readLocal();
    render();
    if(location.hash.startsWith("#reading-")){
      const id=Number(location.hash.slice(9));
      if(Number.isInteger(id)&&id>=1&&id<=518)openAt(id);
    }
  } catch(error) {
    root.textContent="Plán sa nepodarilo načítať. Skontroluj pripojenie a obnov stránku.";
    status.textContent=error.message;
    status.classList.add("error");
    status.hidden = false;
    return;
  }
  document.querySelectorAll(".part-tab").forEach(tab=> {
    const active=Number(tab.dataset.part)===partId;
    tab.classList.toggle("active",active);
    if(active)tab.setAttribute("aria-current","page");
  });
  document.body.addEventListener("change",event=>{
    if(event.target.matches("input.check"))changeScope(event.target);
  });
  jumpButton.addEventListener("click",()=> {
    const next=firstIncomplete();
    if(next)openAt(next.id);
  });
  document.getElementById("export").addEventListener("click",exportProgress);
  document.getElementById("import").addEventListener("click",()=>fileInput.click());
  fileInput.addEventListener("change",()=>importProgress(fileInput.files?.[0]));
  window.addEventListener("storage",event=>{
    if(event.key!==STORE_KEY)return;
    progress=readLocal();
    refresh();
  });
}
init();
