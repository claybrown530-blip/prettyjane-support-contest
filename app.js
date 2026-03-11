const API = "/.netlify/functions/vote";
const THRESHOLD = 10;
let chart;

// Cache per city: { [city]: { ts: number, data: object } }
const cache = {};
const CACHE_TTL_MS = 15000;

const cityStops = [
  "OKC, OK",
  "Durango, CO",
  "Santa Fe, NM",
  "Spokane, WA",
  "Vancouver, BC",
  "Seattle, WA",
  "San Francisco, CA",
  "San Diego, CA",
];

let okcBands = [];

const form = document.getElementById("voteForm");
const toast = document.getElementById("toast");
const citySelect = document.getElementById("citySelect");
const citySelectBoard = document.getElementById("citySelectBoard");
const seedList = document.getElementById("seedList");
const topList = document.getElementById("topList");
const bandEmailWrap = document.getElementById("bandEmailWrap");
const loadState = document.getElementById("loadState");
const voteCard = document.getElementById("voteCard");
const okcBandPicker = document.getElementById("okcBandPicker");
const okcBandButtons = document.getElementById("okcBandButtons");
const bandNameWrap = document.getElementById("bandNameWrap");
const bandNameInput = document.getElementById("bandName");
const cityClosedMsg = document.getElementById("cityClosedMsg");

function setLoading(isLoading){
  if (!loadState) return;
  loadState.textContent = isLoading ? "Loading…" : "";
}

function showToastHTML(html){
  toast.innerHTML = html;
  toast.classList.remove("hidden");
  setTimeout(()=>toast.classList.add("hidden"), 12000);
}

function confettiBurst(){
  const colors = ["#2B4289", "#E11D48", "#111827", "#F59E0B"];
  const count = 24;
  for (let i=0; i<count; i++){
    const d = document.createElement("div");
    d.className = "confetti";
    d.style.left = Math.random()*100 + "vw";
    d.style.background = colors[Math.floor(Math.random()*colors.length)];
    d.style.transform = `translateY(0) rotate(${Math.random()*180}deg)`;
    d.style.animationDuration = (700 + Math.random()*500) + "ms";
    document.body.appendChild(d);
    setTimeout(()=>d.remove(), 1400);
  }
}

function setBandNameAndScroll(name){
  const bandInput = document.getElementById("bandName");
  bandInput.value = name;
  bandInput.focus({ preventScroll: true });
  voteCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function copyShareLink(city){
  const url = new URL(window.location.href);
  url.searchParams.set("city", city);
  return navigator.clipboard.writeText(url.toString());
}

function getVoterType(){
  const el = form.querySelector('input[name="voterType"]:checked');
  return el ? el.value : "individual";
}

form.addEventListener("change", ()=>{
  const vt = getVoterType();
  bandEmailWrap.classList.toggle("hidden", vt !== "band");
});

async function fetchCity(city){
  const res = await fetch(`${API}?city=${encodeURIComponent(city)}`, { cache: "no-store" });
  const data = await res.json().catch(()=> ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `Backend error (status ${res.status})`);
  cache[city] = { ts: Date.now(), data };
  return data;
}

function computeLeaderboard(data){
  const totals = data.totals || {};
  const entries = Object.entries(totals).map(([name,count])=>({name,count}));
  entries.sort((a,b)=>b.count - a.count);
  return entries;
}

function renderSeedCandidates(data, city){
  const seedsWrap = seedList?.closest(".seedSection") || seedList?.parentElement;
  if (seedsWrap) seedsWrap.classList.add("hidden");
  if (seedList) seedList.innerHTML = "";
}

function renderTopList(entries){
  topList.innerHTML = "";
  if (!entries.length){
    topList.innerHTML = `<div class="topitem"><strong>No votes yet</strong><span>Be the first.</span></div>`;
    return;
  }
  entries.slice(0,8).forEach((e,i)=>{
    const row = document.createElement("div");
    row.className = "topitem";
    row.innerHTML = `<strong>${i+1}. ${e.name}</strong><span>${e.count} vote${e.count===1?"":"s"}</span>`;
    row.onclick = ()=> setBandNameAndScroll(e.name);
    topList.appendChild(row);
  });
}

function renderChart(entries){
  const eligible = entries.filter(e=>e.count >= THRESHOLD).slice(0,8);
  const labels = eligible.map(e=>e.name);
  const values = eligible.map(e=>e.count);

  const ctx = document.getElementById("chart");
  if (!chart){
    chart = new Chart(ctx, {
      type: "bar",
      data: { labels, datasets: [{ label: "Votes", data: values }] },
      options: {
        responsive: true,
        plugins: { legend: { display: false }},
        scales: { y: { beginAtZero: true } }
      }
    });
  } else {
    chart.data.labels = labels;
    chart.data.datasets[0].data = values;
    chart.update();
  }
}

function renderCity(city, data){
  if (city === "OKC, OK") {
    okcBands = (data.seeds || []).map(b => typeof b === "string" ? b : b.name).filter(Boolean);
    renderOkcButtons();
  }
  // Keep dropdowns aligned
  if (citySelect.value !== city) citySelect.value = city;
  if (citySelectBoard.value !== city) citySelectBoard.value = city;

  const entries = computeLeaderboard(data);
  renderTopList(entries);
  renderChart(entries);
  renderSeedCandidates(data, city);
}

async function refresh(force=false){
  const city = citySelectBoard.value || citySelect.value;

  // Instant render from cache if present
  const cached = cache[city];
  const fresh = cached && (Date.now() - cached.ts) < CACHE_TTL_MS;

  if (cached) renderCity(city, cached.data);

  if (!fresh || force){
    try{
      setLoading(true);
      const data = await fetchCity(city);
      renderCity(city, data);
    }catch(err){
      showToastHTML(`<strong>${err.message}</strong>`);
    }finally{
      setLoading(false);
    }
  }
}

function setCity(city){
  citySelect.value = city;
  citySelectBoard.value = city;
  updateBandInputMode(city);

  // Update URL for shareability
  const url = new URL(window.location.href);
  url.searchParams.set("city", city);
  window.history.replaceState({}, "", url.toString());

  refresh(false);
}

function renderOkcButtons(){
  if (!okcBandButtons) return;
  okcBandButtons.innerHTML = "";
  okcBands.forEach(name => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "okcBandBtn";
    btn.textContent = name;
    if (bandNameInput.value === name) btn.classList.add("active");
    btn.onclick = () => {
      bandNameInput.value = name;
      document.querySelectorAll(".okcBandBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    };
    okcBandButtons.appendChild(btn);
  });
}

function updateBandInputMode(city){
  const isOKC = city === "OKC, OK";

  if (typeof cityClosedMsg !== "undefined" && cityClosedMsg) {
    cityClosedMsg.classList.toggle("hidden", !isOKC);
  }

  if (okcBandPicker) okcBandPicker.classList.toggle("hidden", false);
  if (bandNameWrap) bandNameWrap.classList.add("hidden");

  const formControls = voteForm?.querySelectorAll("input, button, textarea, select");
  if (formControls) {
    formControls.forEach(el => {
      if (el.id !== "citySelect" && el.id !== "citySelectBoard") {
        if (isOKC && el.name !== "city") el.disabled = true;
        if (!isOKC) el.disabled = false;
      }
    });
  }

  if (isOKC) {
    if (bandNameInput) {
      bandNameInput.placeholder = "OKC voting is closed";
      bandNameInput.value = "";
    }
    document.querySelectorAll(".okcBandBtn").forEach(b => b.classList.remove("active"));
  } else {
    if (bandNameInput) {
      bandNameInput.placeholder = "Choose one of the listed bands";
      if (!okcBands.includes(bandNameInput.value)) bandNameInput.value = "";
    }
    renderOkcButtons();
  }
}

// Build both city selects
function buildCitySelects(){
  cityStops.forEach(c=>{
    const opt1 = document.createElement("option");
    opt1.value = c;
    opt1.textContent = c;
    citySelect.appendChild(opt1);

    const opt2 = document.createElement("option");
    opt2.value = c;
    opt2.textContent = c;
    citySelectBoard.appendChild(opt2);
  });
}

// Sync city changes either direction
citySelectBoard.addEventListener("change", () => setCity(citySelectBoard.value));
citySelect.addEventListener("change", () => setCity(citySelect.value));

form.addEventListener("submit", async (e)=>{
  e.preventDefault();
  const fd = new FormData(form);

  const payload = {
    voterName: fd.get("voterName"),
    voterEmail: fd.get("voterEmail"),
    voterPhone: fd.get("voterPhone"),
    voterType: fd.get("voterType"),
    bandContactEmail: fd.get("bandContactEmail"),
    city: fd.get("city"),
    bandName: fd.get("bandName"),
  };

  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const out = await res.json().catch(()=> ({}));
  if (!res.ok || !out.ok){
    showToastHTML(`<strong>${out.error || `Vote failed (status ${res.status})`}</strong>`);
    return;
  }

  confettiBurst();

  const count = out.count || 1;
  const progress = count < THRESHOLD
    ? `<div class="mini">${count}/${THRESHOLD} votes to hit the leaderboard.</div>`
    : `<div class="mini">🎉 ${out.bandName} is on the leaderboard.</div>`;

  showToastHTML(`
    <strong>${out.message}</strong>
    ${progress}
    <div class="shareRow">
      <button class="shareBtn" id="shareBtn">Copy share link</button>
      <div class="mini">Send it to your group chat.</div>
    </div>
  `);

  const shareBtn = document.getElementById("shareBtn");
  if (shareBtn){
    shareBtn.onclick = async () => {
      try{
        await copyShareLink(out.city);
        shareBtn.textContent = "Copied ✅";
        setTimeout(()=>shareBtn.textContent="Copy share link", 2500);
      }catch{
        shareBtn.textContent = "Copy failed";
        setTimeout(()=>shareBtn.textContent="Copy share link", 2500);
      }
    };
  }

  // Force refresh so counts update immediately
if (out.snapshot) {
      cache[out.city] = { ts: Date.now(), data: out.snapshot };
      renderBoard(out.snapshot);
    }

      await refresh(true);

  form.reset();
  bandEmailWrap.classList.add("hidden");
});

// Initialize
buildCitySelects();

// Load city from URL param if present
const params = new URLSearchParams(window.location.search);
const cityParam = params.get("city");
if (cityParam && cityStops.includes(cityParam)){
  setCity(cityParam);
} else {
  setCity(cityStops[0]);
}

// Poll selected city (light)
setInterval(()=>refresh(false), 12000);
