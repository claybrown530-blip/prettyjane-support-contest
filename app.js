const API = "/.netlify/functions/vote";
const THRESHOLD = 10;
let chart;

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

function showToast(msg){
  toast.textContent = msg;
  toast.classList.remove("hidden");
  setTimeout(()=>toast.classList.add("hidden"), 8000);
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

async function fetchData(city){
  const res = await fetch(`${API}?city=${encodeURIComponent(city)}`);
  return await res.json();
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

async function refresh(){
  const city = citySelect.value;
  const data = await fetchData(city);
  const entries = computeLeaderboard(data);
  renderSeedCandidates(data);
  renderTopList(entries);
  renderChart(entries);
}

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

  const out = await res.json();
  if (!out.ok){
    showToast(out.error || "Something went wrong.");
    return;
  }

  showToast(out.message);
  await refresh();
  form.reset();
  bandEmailWrap.classList.add("hidden");
});

buildCitySelect();
refresh();
setInterval(refresh, 10000);
