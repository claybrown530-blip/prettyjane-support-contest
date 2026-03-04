const API = "/.netlify/functions/vote";
const THRESHOLD = 10;
let chart;

// Cache per city: { [city]: { ts: number, data: object } }
const cache = {};
const CACHE_TTL_MS = 15000; // 15s - feels live, avoids hammering network

const cityStops = [
  "Durango, CO",
  "Spokane, WA",
  "Vancouver, BC",
  "Seattle, WA",
  "San Francisco, CA",
  "San Diego, CA",
];

const form = document.getElementById("voteForm");
const toast = document.getElementById("toast");
const citySelect = document.getElementById("citySelect");
const seedList = document.getElementById("seedList");
const topList = document.getElementById("topList");
const bandEmailWrap = document.getElementById("bandEmailWrap");
const loadState = document.getElementById("loadState");

function showToast(msg){
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(()=>toast.classList.add("hidden"), 8000);
}

function setLoading(isLoading){
  if (!loadState) return;
  loadState.textContent = isLoading ? "Loading…" : "";
}

function buildCitySelect(){
  cityStops.forEach(c=>{
    const opt = document.createElement("option");
    opt.value = c;
    opt.textContent = c;
    citySelect.appendChild(opt);
  });
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
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Backend error (status ${res.status})`);
  }
  cache[city] = { ts: Date.now(), data };
  return data;
}

function computeLeaderboard(data){
  const totals = data.totals || {};
  const entries = Object.entries(totals).map(([name,count])=>({name,count}));
  entries.sort((a,b)=>b.count - a.count);
  return entries;
}

function renderSeedCandidates(data){
  seedList.innerHTML = "";
  const seeds = (data.seeds || []).map(b=>b.name);
  if (!seeds.length){
    seedList.textContent = "No starter candidates yet.";
    return;
  }
  seeds.forEach(n=>{
    const pill = document.createElement("div");
    pill.className = "seedpill";
    pill.textContent = n;
    pill.onclick = ()=> {
      document.getElementById("bandName").value = n;
      document.getElementById("bandName").focus();
    };
    seedList.appendChild(pill);
  });
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
  const ac = document.getElementById("activeCity");
  if (ac) ac.firstChild ? null : null;
  // keep your existing city label behavior
  const acEl = document.getElementById("activeCity");
  if (acEl) acEl.childNodes[0].textContent = `City: ${city} `;
  const entries = computeLeaderboard(data);
  renderSeedCandidates(data);
  renderTopList(entries);
  renderChart(entries);
}

async function refresh(force=false){
  const city = citySelect.value;

  // 1) Instant render from cache if present
  const cached = cache[city];
  const fresh = cached && (Date.now() - cached.ts) < CACHE_TTL_MS;

  if (cached) {
    renderCity(city, cached.data);
  }

  // 2) Only fetch if forced or cache is stale/missing
  if (!fresh || force) {
    try {
      setLoading(true);
      const data = await fetchCity(city);
      renderCity(city, data);
    } catch (err) {
      showToast(err.message);
    } finally {
      setLoading(false);
    }
  }
}

// When user changes city: render instantly, then refresh in background
citySelect.addEventListener("change", () => {
  refresh(false);
});

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
    showToast(out.error || `Vote failed (status ${res.status})`);
    return;
  }

  showToast(out.message);

  // Force refresh this city so counts update immediately
  await refresh(true);

  form.reset();
  bandEmailWrap.classList.add("hidden");
});

buildCitySelect();
refresh(true);

// poll selected city every 12s (slightly slower, less jitter)
setInterval(()=>refresh(false), 12000);
