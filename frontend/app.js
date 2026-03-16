/**
 * TrainPascher — Frontend SPA
 * Concept: Afficher TOUS les trains du jour avec analyse des correspondances
 */

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:8787"
  : "https://trainpascher-worker.qmpro.workers.dev";

// ── State ─────────────────────────────────────────────────────────────────
let selectedFrom = null;
let selectedTo   = null;
let lastSearch   = null;
let currentSearchParams = null;
let turnstileToken = null;
let activeFilter = 'all';
let allJourneys = [];
const acCache = { from: [], to: [] };
const acTimers = {};

let userId = localStorage.getItem("tp_uid");
if (!userId) { userId = crypto.randomUUID(); localStorage.setItem("tp_uid", userId); }

let selectedCard = localStorage.getItem("tp_card") || "none";

// ── Turnstile ─────────────────────────────────────────────────────────────
function onTurnstileSuccess(token) { turnstileToken = token; }

// ── Tabs ──────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");
  if (name === "alerts")   loadAlerts();
  if (name === "trending") loadTrending();
}

// ── Card selector ─────────────────────────────────────────────────────────
document.getElementById("card-pills").addEventListener("click", e => {
  const pill = e.target.closest(".card-pill");
  if (!pill) return;
  selectedCard = pill.dataset.card;
  localStorage.setItem("tp_card", selectedCard);
  document.querySelectorAll(".card-pill").forEach(p => p.classList.remove("active"));
  pill.classList.add("active");
});

document.querySelectorAll(".card-pill").forEach(p => {
  if (p.dataset.card === selectedCard) p.classList.add("active");
  else p.classList.remove("active");
});

// ── Autocomplete ──────────────────────────────────────────────────────────
function onStationInput(field) {
  clearTimeout(acTimers[field]);
  const q = document.getElementById(`input-${field}`).value.trim();
  if (field === "from") selectedFrom = null;
  else selectedTo = null;
  if (q.length < 2) { document.getElementById(`suggestions-${field}`).classList.add("hidden"); return; }
  acTimers[field] = setTimeout(() => fetchSuggestions(field, q), 280);
}

async function fetchSuggestions(field, q) {
  try {
    const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}`);
    const places = await res.json();
    acCache[field] = places;
    renderSuggestions(field, places);
  } catch (_) {}
}

function renderSuggestions(field, places) {
  const el = document.getElementById(`suggestions-${field}`);
  if (!places.length) { el.classList.add("hidden"); return; }
  el.innerHTML = places.map((p, i) => `
    <div class="suggestion-item" onclick="selectStation('${field}', ${i})">
      <span class="sug-name">${p.name}</span>
      <span class="sug-label">${p.city || p.id}</span>
    </div>`).join("");
  el.classList.remove("hidden");
}

function selectStation(field, i) {
  const place = acCache[field][i];
  if (!place) return;
  document.getElementById(`input-${field}`).value = place.name;
  document.getElementById(`suggestions-${field}`).classList.add("hidden");
  if (field === "from") selectedFrom = place;
  else selectedTo = place;
}

function swapStations() {
  const fi = document.getElementById("input-from");
  const ti = document.getElementById("input-to");
  [fi.value, ti.value] = [ti.value, fi.value];
  [selectedFrom, selectedTo] = [selectedTo, selectedFrom];
}

document.addEventListener("click", e => {
  if (!e.target.closest(".autocomplete-wrap"))
    document.querySelectorAll(".suggestions").forEach(s => s.classList.add("hidden"));
});

// ── Search ────────────────────────────────────────────────────────────────
async function doSearch() {
  hideError();
  document.getElementById("results-section").classList.add("hidden");

  if (!selectedFrom) { showError("Veuillez sélectionner une gare de départ dans la liste."); return; }
  if (!selectedTo)   { showError("Veuillez sélectionner une gare d'arrivée dans la liste."); return; }

  const date = document.getElementById("input-date").value;
  if (!date) { showError("Veuillez sélectionner une date."); return; }

  currentSearchParams = {
    fromId: selectedFrom.id, fromName: selectedFrom.name, fromCity: selectedFrom.city,
    toId: selectedTo.id, toName: selectedTo.name, toCity: selectedTo.city,
    date,
  };

  setLoading(true);

  try {
    const body = {
      from_id: selectedFrom.id, from_name: selectedFrom.name, from_city: selectedFrom.city,
      to_id: selectedTo.id, to_name: selectedTo.name, to_city: selectedTo.city,
      date, card_type: selectedCard, turnstile_token: turnstileToken || "dummy",
    };

    const res = await fetch(`${API}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || "Erreur lors de la recherche."); return; }

    lastSearch = { from: selectedFrom, to: selectedTo, date, data };
    saveQuickRoute(selectedFrom.name, selectedTo.name, selectedFrom.id, selectedTo.id);
    renderResults(data, date);
  } catch (_) {
    showError("Impossible de contacter le serveur. Vérifiez votre connexion.");
  } finally {
    setLoading(false);
  }
}

async function navigateDay(delta) {
  if (!currentSearchParams) return;
  const d = new Date(currentSearchParams.date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  const newDate = d.toISOString().slice(0, 10);
  currentSearchParams.date = newDate;
  document.getElementById("input-date").value = newDate;

  setLoading(true);
  hideError();
  document.getElementById("results-section").classList.add("hidden");

  try {
    const body = {
      from_id: currentSearchParams.fromId, from_name: currentSearchParams.fromName,
      from_city: currentSearchParams.fromCity, to_id: currentSearchParams.toId,
      to_name: currentSearchParams.toName, to_city: currentSearchParams.toCity,
      date: newDate, card_type: selectedCard, turnstile_token: turnstileToken || "dummy",
    };
    const res = await fetch(`${API}/api/search`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || "Erreur."); return; }
    lastSearch = { from: selectedFrom, to: selectedTo, date: newDate, data };
    renderResults(data, newDate);
  } catch (_) {
    showError("Impossible de contacter le serveur.");
  } finally {
    setLoading(false);
  }
}

function setLoading(v) {
  document.getElementById("search-btn").disabled = v;
  document.getElementById("search-btn-text").textContent = v ? "Recherche…" : "Rechercher";
  document.getElementById("search-spinner").classList.toggle("hidden", !v);
}

function showError(msg) {
  const el = document.getElementById("error-box");
  el.textContent = "⚠️ " + msg;
  el.classList.remove("hidden");
}
function hideError() { document.getElementById("error-box").classList.add("hidden"); }

// ── Results ───────────────────────────────────────────────────────────────
function renderResults(data, date) {
  const section = document.getElementById("results-section");

  // Route + date header
  document.getElementById("results-route").textContent = `${data.from_name} → ${data.to_name}`;
  const d = new Date(date + "T12:00:00Z");
  document.getElementById("results-date-label").textContent =
    d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  section.classList.remove("hidden");
  activeFilter = 'all';
  document.querySelectorAll(".filter-chip").forEach(c => c.classList.toggle("active", c.dataset.filter === 'all'));

  allJourneys = data.journeys || [];

  // Summary
  const direct = allJourneys.filter(j => j.transfers === 0).length;
  const indirect = allJourneys.filter(j => j.transfers > 0).length;
  const priced = allJourneys.filter(j => j.total_min_price !== null);
  const minP = priced.length ? Math.min(...priced.map(j => j.total_min_price)) : null;

  let summaryParts = [];
  if (allJourneys.length > 0) summaryParts.push(`${allJourneys.length} trains`);
  if (direct > 0) summaryParts.push(`${direct} direct${direct > 1 ? 's' : ''}`);
  if (indirect > 0) summaryParts.push(`${indirect} avec correspondance${indirect > 1 ? 's' : ''}`);
  if (minP !== null) summaryParts.push(`Dès ~${minP}€ <span class="indicatif-note">indicatif</span>`);

  document.getElementById("results-summary").innerHTML = summaryParts.join(' · ');

  // Day timeline
  const timelineEl = document.getElementById("day-timeline");
  if (allJourneys.length > 0) {
    timelineEl.innerHTML = buildTimeline(allJourneys);
    timelineEl.classList.remove("hidden");
  } else {
    timelineEl.classList.add("hidden");
  }

  // Journey list
  renderJourneyList();

  // Alert CTA
  document.getElementById("alert-cta").classList.toggle("hidden", allJourneys.length === 0 && !data.main_fares?.length);
}

function renderJourneyList() {
  const listEl = document.getElementById("journey-list");

  if (allJourneys.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><span>🔍</span><p>Aucun train trouvé pour ce trajet.<br/>Essayez d'autres gares ou une date différente.</p></div>`;
    return;
  }

  let filtered = allJourneys;
  if (activeFilter === 'direct') filtered = allJourneys.filter(j => j.transfers === 0);
  else if (activeFilter === 'safe') filtered = allJourneys.filter(j => !j.connection_risk || j.connection_risk !== 'high');

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><span>🔍</span><p>Aucun train correspondant à ce filtre.</p></div>`;
    return;
  }

  listEl.innerHTML = filtered.map(j => renderJourneyCard(j, allJourneys.indexOf(j))).join('');
}

function setFilter(f) {
  activeFilter = f;
  document.querySelectorAll(".filter-chip").forEach(c => c.classList.toggle("active", c.dataset.filter === f));
  renderJourneyList();
}

// ── Carrier helpers ───────────────────────────────────────────────────────
function carrierInfo(carrier) {
  const c = (carrier || '').toUpperCase();
  if (c.includes('TGV') || c === 'INOUI') return { cls: 'carrier-tgv', icon: '🔵', label: carrier };
  if (c.includes('OUIGO')) return { cls: 'carrier-ouigo', icon: '🟠', label: carrier };
  if (c.includes('TER') || c.includes('REGIONAL')) return { cls: 'carrier-ter', icon: '🟢', label: carrier };
  if (c.includes('INTERCIT') || c.includes('NTERCIT')) return { cls: 'carrier-ic', icon: '🟣', label: carrier };
  return { cls: 'carrier-other', icon: '⚫', label: carrier };
}

function formatDuration(min) {
  if (!min) return '';
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}h${m > 0 ? m.toString().padStart(2, '0') : ''}` : `${m}min`;
}

function cleanStation(name) {
  return (name || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function buildBookingUrl(j) {
  const fromName = cleanStation(j.sections[0]?.from || '');
  const toName = cleanStation(j.sections[j.sections.length - 1]?.to || '');
  const isOuigo = j.sections.some(s => (s.carrier || '').toUpperCase().includes('OUIGO'));
  if (isOuigo) return 'https://www.ouigo.com';
  const dateStr = (j.dep_date || '').replace(/-/g, '');
  return `https://www.sncf-connect.com/app/home/search?originLabel=${encodeURIComponent(fromName)}&destinationLabel=${encodeURIComponent(toName)}&outwardDate=${dateStr}&passengers=1`;
}

// ── Journey card ──────────────────────────────────────────────────────────
function renderJourneyCard(j, index) {
  // Tags
  const tagMap = {
    recommended: '<span class="jtag jtag-rec">⭐ Recommandé</span>',
    fastest:     '<span class="jtag jtag-fast">⚡ Le plus rapide</span>',
    cheapest:    '<span class="jtag jtag-cheap">💰 Meilleur tarif</span>',
  };
  const tagsHtml = (j.tags || []).map(t => tagMap[t] || '').filter(Boolean).join('');

  const fromStation = cleanStation(j.sections[0]?.from || '');
  const toStation   = cleanStation(j.sections[j.sections.length - 1]?.to || '');
  const dur = formatDuration(j.dur_min);
  const transferLabel = j.transfers === 0 ? 'Direct' : `${j.transfers} correspondance${j.transfers > 1 ? 's' : ''}`;

  // Journey line visualization
  let lineHtml = '';
  if (!j.connections || j.connections.length === 0) {
    const ci = carrierInfo(j.sections[0]?.carrier);
    lineHtml = `<div class="jline-seg ${ci.cls}"></div>`;
  } else {
    lineHtml = j.sections.map((s, i) => {
      const ci = carrierInfo(s.carrier);
      const connHtml = j.connections[i]
        ? `<div class="jline-conn conn-${j.connections[i].risk}" title="${j.connections[i].at} — ${j.connections[i].dur_min}min"></div>`
        : '';
      return `<div class="jline-seg ${ci.cls}"></div>${connHtml}`;
    }).join('');
  }

  // Carrier badges
  const carrierBadges = j.sections.map(s => {
    const ci = carrierInfo(s.carrier);
    const num = s.headsign ? ` · N°${s.headsign}` : '';
    return `<span class="carrier-badge ${ci.cls}">${ci.icon} ${s.carrier}${num}</span>`;
  }).join('');

  // Connection risk notice
  let riskHtml = '';
  if (j.connections && j.connections.length > 0) {
    riskHtml = j.connections.map(c => {
      const riskIcon = c.risk === 'high' ? '🔴' : c.risk === 'medium' ? '🟡' : '🟢';
      const riskWord = c.risk === 'high' ? 'risquée' : c.risk === 'medium' ? 'limite' : 'confortable';
      return `<div class="connection-notice risk-${c.risk}">
        ${riskIcon} Correspondance <strong>${riskWord}</strong> à <strong>${cleanStation(c.at)}</strong> — ${c.dur_min} min
      </div>`;
    }).join('');
  }

  // Section detail (for multi-leg)
  let sectionDetailHtml = '';
  if (j.sections.length > 1) {
    sectionDetailHtml = '<div class="section-detail">' + j.sections.map((s, i) => {
      const ci = carrierInfo(s.carrier);
      const connRow = j.connections?.[i]
        ? `<div class="sd-conn conn-${j.connections[i].risk}">
            ${j.connections[i].risk === 'high' ? '🔴' : j.connections[i].risk === 'medium' ? '🟡' : '🟢'}
            Correspondance ${j.connections[i].dur_min} min à ${cleanStation(j.connections[i].at)}
           </div>`
        : '';
      return `<div class="sd-row">
        <span class="carrier-badge-sm ${ci.cls}">${ci.icon} ${s.carrier}</span>
        <span class="sd-time">${s.dep}–${s.arr}</span>
        <span class="sd-stations">${cleanStation(s.from)} → ${cleanStation(s.to)}</span>
      </div>${connRow}`;
    }).join('') + '</div>';
  }

  // Price
  let priceHtml = '';
  if (j.total_min_price !== null) {
    const est = j.price_is_estimate ? '~estimé' : 'indicatif';
    priceHtml = `<span class="jprice ${j.price_is_estimate ? 'jprice-est' : ''}">~${j.total_min_price}€ <span class="jprice-note">${est}</span></span>`;
  } else {
    const terEst = j.sections.find(s => s.ter_estimate);
    if (terEst?.ter_estimate) {
      priceHtml = `<span class="jprice jprice-est">~${terEst.ter_estimate.price_min}–${terEst.ter_estimate.price_max}€ <span class="jprice-note">~estimé TER</span></span>`;
    } else {
      priceHtml = `<span class="jprice jprice-unknown">Voir SNCF Connect</span>`;
    }
  }

  const bookUrl = buildBookingUrl(j);
  const isRec = (j.tags || []).includes('recommended');

  return `<div class="jcard${isRec ? ' jcard-recommended' : ''}" data-transfers="${j.transfers}" data-risk="${j.connection_risk || 'none'}" data-index="${index}" id="jcard-${index}">
    ${tagsHtml ? `<div class="jtags-row">${tagsHtml}</div>` : ''}
    <div class="jcard-body">
      <div class="jtime-col">
        <div class="jtime-big">${j.dep_time}</div>
        <div class="jstation-name">${fromStation}</div>
      </div>
      <div class="jtime-mid">
        <div class="jdur-label">${dur}</div>
        <div class="jline-visual">${lineHtml}</div>
        <div class="jtransfer-label${j.transfers === 0 ? ' label-direct' : ''}">${transferLabel}</div>
      </div>
      <div class="jtime-col jtime-col-right">
        <div class="jtime-big">${j.arr_time}</div>
        <div class="jstation-name">${toStation}</div>
      </div>
    </div>
    <div class="jcard-carriers">${carrierBadges}</div>
    ${riskHtml}
    ${sectionDetailHtml}
    <div class="jcard-footer">
      ${priceHtml}
      <a href="${bookUrl}" class="jbook-btn" target="_blank" rel="noopener">Réserver →</a>
    </div>
  </div>`;
}

// ── Day Timeline ──────────────────────────────────────────────────────────
function buildTimeline(journeys) {
  if (!journeys || journeys.length === 0) return '';
  const START = 5 * 60;
  const END = 23 * 60;
  const range = END - START;

  const dots = journeys.map((j, i) => {
    const parts = (j.dep_time || '00:00').split(':').map(Number);
    const mins = (parts[0] || 0) * 60 + (parts[1] || 0);
    const pct = Math.max(1, Math.min(99, ((mins - START) / range) * 100));
    const ci = carrierInfo(j.sections?.[0]?.carrier);
    const ring = j.transfers > 0 ? ' tdot-ring' : '';
    const riskClass = j.connection_risk === 'high' ? ' tdot-risky' : '';
    return `<div class="tdot ${ci.cls}${ring}${riskClass}" style="left:${pct.toFixed(1)}%"
      title="${j.dep_time} · ${j.sections?.[0]?.carrier || ''} · ${j.transfers === 0 ? 'Direct' : j.transfers + ' correspondance(s)'}"
      onclick="scrollToJourney(${i})"></div>`;
  }).join('');

  const labels = [];
  for (let h = 6; h <= 22; h += 2) {
    const pct = ((h * 60 - START) / range) * 100;
    if (pct >= 0 && pct <= 100) {
      labels.push(`<span class="tlabel" style="left:${pct.toFixed(1)}%">${h}h</span>`);
    }
  }

  return `<div class="day-timeline">
    <div class="ttrack">${dots}</div>
    <div class="tlabels">${labels.join('')}</div>
  </div>`;
}

function scrollToJourney(index) {
  const el = document.getElementById(`jcard-${index}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('jcard-pulse');
  setTimeout(() => el.classList.remove('jcard-pulse'), 1500);
}

// ── Quick routes ──────────────────────────────────────────────────────────
function saveQuickRoute(fromName, toName, fromId, toId) {
  let routes = JSON.parse(localStorage.getItem("tp_quick") || "[]");
  const key = `${fromId}:${toId}`;
  routes = routes.filter(r => r.key !== key);
  routes.unshift({ key, fromName, toName, fromId, toId });
  routes = routes.slice(0, 4);
  localStorage.setItem("tp_quick", JSON.stringify(routes));
  renderQuickRoutes();
}

function renderQuickRoutes() {
  const routes = JSON.parse(localStorage.getItem("tp_quick") || "[]");
  const el = document.getElementById("quick-routes");
  if (!routes.length) { el.classList.add("hidden"); return; }
  el.innerHTML = routes.map(r => `
    <button class="quick-route-btn" onclick="quickSearch('${r.fromName}','${r.toName}','${r.fromId}','${r.toId}')">
      ${r.fromName} → ${r.toName}
    </button>`).join("");
  el.classList.remove("hidden");
}

function quickSearch(fromName, toName, fromId, toId) {
  document.getElementById("input-from").value = fromName;
  document.getElementById("input-to").value   = toName;
  selectedFrom = { id: fromId, name: fromName, city: fromName.split(" ")[0] };
  selectedTo   = { id: toId,   name: toName,   city: toName.split(" ")[0] };
  doSearch();
}

// ── Alerts ────────────────────────────────────────────────────────────────
function openAlertModal() {
  if (!lastSearch) return;
  document.getElementById("modal-route").textContent = `${lastSearch.from.name} → ${lastSearch.to.name}`;
  document.getElementById("alert-modal").classList.remove("hidden");
}
function closeAlertModal() {
  document.getElementById("alert-modal").classList.add("hidden");
  document.getElementById("alert-price").value = "";
  document.getElementById("alert-email").value = "";
}
async function saveAlert() {
  if (!lastSearch) return;
  const maxPrice = parseFloat(document.getElementById("alert-price").value) || null;
  const email = document.getElementById("alert-email").value.trim() || null;
  try {
    const res = await fetch(`${API}/api/alerts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId, from_station: lastSearch.from.name, from_id: lastSearch.from.id,
        to_station: lastSearch.to.name, to_id: lastSearch.to.id,
        max_price: maxPrice, email, card_type: selectedCard,
      }),
    });
    if (res.ok) { closeAlertModal(); toast("✅ Alerte créée !"); }
  } catch (_) { alert("Impossible de créer l'alerte."); }
}

async function loadAlerts() {
  const el = document.getElementById("alerts-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;
  try {
    const res = await fetch(`${API}/api/alerts?user_id=${userId}`);
    const d = await res.json();
    const alerts = d.alerts || [];
    if (!alerts.length) {
      el.innerHTML = `<div class="empty-state"><span>🔔</span><p>Aucune alerte.<br/>Faites une recherche et créez-en une !</p></div>`;
      return;
    }
    el.innerHTML = alerts.map(a => `
      <div class="alert-item" id="al-${a.id}">
        <div class="alert-route">${a.from_station} → ${a.to_station}</div>
        ${a.max_price ? `<span class="alert-badge">≤ ${a.max_price} €</span>` : ""}
        <button class="alert-del" onclick="deleteAlert('${a.id}')">Supprimer</button>
      </div>`).join("");
  } catch (_) { el.innerHTML = `<div class="loading-state">Impossible de charger.</div>`; }
}

async function deleteAlert(id) {
  await fetch(`${API}/api/alerts?id=${id}&user_id=${userId}`, { method: "DELETE" });
  document.getElementById(`al-${id}`)?.remove();
}

// ── Trending ──────────────────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById("trending-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;
  try {
    const res = await fetch(`${API}/api/trending`);
    const rows = await res.json();
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state"><p>Pas encore de données.</p></div>`;
      return;
    }
    el.innerHTML = `<div class="trending-grid">` + rows.map(r => `
      <div class="trending-card" onclick="prefillSearch('${r.from_station}','${r.to_station}')">
        <div class="trending-route">${r.from_station} → ${r.to_station}</div>
        <div class="trending-stats">${r.searches} recherche${r.searches > 1 ? "s" : ""}</div>
        ${r.best_price ? `<div class="trending-price">~${Math.round(r.best_price)} €</div>` : ""}
      </div>`).join("") + `</div>`;
  } catch (_) { el.innerHTML = `<div class="loading-state">Impossible de charger.</div>`; }
}

function prefillSearch(from, to) {
  showTab("search");
  document.getElementById("input-from").value = from;
  document.getElementById("input-to").value = to;
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = Object.assign(document.createElement("div"), { textContent: msg, className: "toast" });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────
(function init() {
  const d = new Date(); d.setDate(d.getDate() + 1);
  document.getElementById("input-date").value =
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  ["input-from","input-to","input-date"].forEach(id =>
    document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); })
  );
  renderQuickRoutes();
})();
