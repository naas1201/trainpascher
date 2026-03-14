/**
 * TrainPascher — Frontend SPA
 */

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:8787"
  : "https://trainpascher-worker.qmpro.workers.dev";

// ── State ─────────────────────────────────────────────────────────────────────
let selectedFrom = null;
let selectedTo = null;
let lastSearch = null;
let autocompleteTimers = {};
const suggestionCache = { from: [], to: [] };

let userId = localStorage.getItem("tp_user_id");
if (!userId) { userId = crypto.randomUUID(); localStorage.setItem("tp_user_id", userId); }

// ── Tabs ──────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");
  if (name === "alerts") loadAlerts();
  if (name === "trending") loadTrending();
}

// ── Autocomplete ──────────────────────────────────────────────────────────────
function onStationInput(field) {
  clearTimeout(autocompleteTimers[field]);
  const input = document.getElementById(`input-${field}`);
  const q = input.value.trim();
  if (field === "from") selectedFrom = null;
  else selectedTo = null;

  if (q.length < 2) {
    document.getElementById(`suggestions-${field}`).classList.add("hidden");
    return;
  }

  autocompleteTimers[field] = setTimeout(async () => {
    try {
      const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}`);
      const places = await res.json();
      renderSuggestions(field, places);
    } catch (_) {
      document.getElementById(`suggestions-${field}`).classList.add("hidden");
    }
  }, 280);
}

function renderSuggestions(field, places) {
  const el = document.getElementById(`suggestions-${field}`);
  if (!places.length) { el.classList.add("hidden"); return; }
  suggestionCache[field] = places;
  el.innerHTML = places.map((p, i) => `
    <div class="suggestion-item" onclick="selectStation('${field}', ${i})">
      <div class="station-name">${p.name}</div>
      <div class="station-label">${p.label}</div>
    </div>
  `).join("");
  el.classList.remove("hidden");
}

function selectStation(field, index) {
  const place = suggestionCache[field][index];
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

document.addEventListener("click", (e) => {
  if (!e.target.closest(".autocomplete-wrap"))
    document.querySelectorAll(".suggestions").forEach(s => s.classList.add("hidden"));
});

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const errorEl = document.getElementById("error-section");
  const resultsEl = document.getElementById("results-section");
  errorEl.classList.add("hidden");
  resultsEl.classList.add("hidden");

  if (!selectedFrom) { showError("Veuillez sélectionner une gare de départ dans la liste."); return; }
  if (!selectedTo)   { showError("Veuillez sélectionner une gare d'arrivée dans la liste."); return; }

  const date = document.getElementById("input-date").value;
  setSearchLoading(true);

  try {
    const res = await fetch(`${API}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from_name: selectedFrom.name, to_name: selectedTo.name, date }),
    });
    const data = await res.json();

    if (!res.ok) { showError(data.error || "Erreur lors de la recherche."); return; }

    lastSearch = { from: selectedFrom, to: selectedTo, date };
    renderResults(data);
  } catch (_) {
    showError("Impossible de contacter le serveur. Vérifiez votre connexion.");
  } finally {
    setSearchLoading(false);
  }
}

function setSearchLoading(v) {
  document.querySelector(".search-btn").disabled = v;
  document.getElementById("search-btn-text").textContent = v ? "Recherche…" : "Rechercher";
  document.getElementById("search-spinner").classList.toggle("hidden", !v);
}

function showError(msg) {
  const el = document.getElementById("error-section");
  el.textContent = "⚠️ " + msg;
  el.classList.remove("hidden");
}

// ── Results rendering ─────────────────────────────────────────────────────────

const CARRIER_STYLE = {
  "OUIGO":                { bg: "#fce7f3", text: "#9d174d", border: "#f9a8d4", dot: "#ec4899" },
  "OUIGO TRAIN CLASSIQUE":{ bg: "#fce7f3", text: "#9d174d", border: "#f9a8d4", dot: "#ec4899" },
  "TGV INOUI":            { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe", dot: "#3b82f6" },
};

function carrierStyle(carrier) {
  return CARRIER_STYLE[carrier] || { bg: "var(--gray-100)", text: "var(--gray-700)", border: "var(--gray-200)", dot: "#6b7280" };
}

function renderResults(data) {
  const el = document.getElementById("results-list");
  const titleEl = document.getElementById("results-title");
  const cacheBadge = document.getElementById("results-cache-badge");
  const resultsEl = document.getElementById("results-section");
  const alertCta = document.getElementById("alert-cta");

  titleEl.textContent = `${lastSearch.from.name} → ${lastSearch.to.name}`;
  cacheBadge.classList.toggle("hidden", !data.cached);
  resultsEl.classList.remove("hidden");

  // ── TER route (no TGV/OUIGO service) ──────────────────────────────────────
  if (data.type === "ter_route") {
    const fromHasTgv = data.from_has_tgv;
    const toHasTgv   = data.to_has_tgv;

    // Build a smart hint
    let hint = "";
    if (!fromHasTgv && !toHasTgv) {
      hint = `Ni <strong>${lastSearch.from.name}</strong> ni <strong>${lastSearch.to.name}</strong> ne sont desservies par TGV ou OUIGO. Ce trajet est assuré par <strong>TER</strong> (train régional).`;
    } else if (!fromHasTgv) {
      hint = `<strong>${lastSearch.from.name}</strong> n'est pas desservie par TGV/OUIGO. Ce trajet est assuré par <strong>TER</strong>.`;
    } else if (!toHasTgv) {
      hint = `<strong>${lastSearch.to.name}</strong> n'est pas desservie par TGV/OUIGO. Ce trajet est assuré par <strong>TER</strong>.`;
    } else {
      hint = `Pas de liaison directe TGV/OUIGO entre ces gares. Le trajet se fait probablement en <strong>TER</strong> ou avec correspondance.`;
    }

    const dateParam = lastSearch.date ? lastSearch.date.replace(/-/g, "") : "";
    const connectUrl = data.booking_url;

    el.innerHTML = `
      <div class="ter-card">
        <div class="ter-icon">🚆</div>
        <div class="ter-body">
          <div class="ter-title">Trajet TER</div>
          <p class="ter-hint">${hint}</p>
          <div class="ter-actions">
            <a class="ter-book-btn primary" href="${connectUrl}" target="_blank" rel="noopener">
              Voir les prix &amp; horaires sur SNCF Connect →
            </a>
            <a class="ter-book-btn secondary" href="https://www.ter.sncf.com" target="_blank" rel="noopener">
              Site TER SNCF →
            </a>
          </div>
          <div class="ter-tip">
            💡 <strong>Astuce TrainPascher :</strong> Les prix TER sont souvent fixes. Cherchez une carte <em>Avantage</em> ou <em>Liberté</em> si vous voyagez régulièrement — économies jusqu'à 50 %.
          </div>
        </div>
      </div>
    `;
    alertCta.classList.add("hidden");
    return;
  }

  // ── TGV / OUIGO fares ─────────────────────────────────────────────────────
  if (!data.fares || !data.fares.length) {
    el.innerHTML = `<div class="empty-state"><span>🚫</span><p>Aucune offre trouvée.<br/>Essayez des noms de gares différents.</p></div>`;
    alertCta.classList.add("hidden");
    return;
  }

  // Group fares by carrier for the comparison header
  const byCarrier = {};
  data.fares.forEach(f => {
    if (!byCarrier[f.carrier]) byCarrier[f.carrier] = [];
    byCarrier[f.carrier].push(f);
  });
  const carriers = Object.keys(byCarrier);

  // Summary bar
  const summaryHtml = carriers.map(c => {
    const st = carrierStyle(c);
    const best = byCarrier[c].reduce((a, b) => a.min_price < b.min_price ? a : b);
    return `<div class="summary-chip" style="background:${st.bg};color:${st.text};border-color:${st.border}">
      <span class="summary-carrier">${c}</span>
      <span class="summary-price">à partir de <strong>${best.min_price} €</strong></span>
    </div>`;
  }).join("");

  // Fare cards
  const faresHtml = data.fares.map(f => {
    const st = carrierStyle(f.carrier);
    const bookUrl = f.carrier.includes("OUIGO") ? data.ouigo_url : data.booking_url;

    const profilesHtml = f.profiles.map(p => {
      // Shorten profile name
      const shortName = p.name
        .replace("Tarif ", "")
        .replace("Élève - Étudiant - Apprenti", "Étudiant/Élève")
        .replace("Elève - Etudiant - Apprenti", "Étudiant/Élève")
        .replace("Réglementé", "Réglementé");
      const isNormal = p.name === "Tarif Normal";
      return `<div class="profile-row ${isNormal ? 'profile-normal' : ''}">
        <span class="profile-name">${shortName}</span>
        <span class="profile-price">${p.min} € <span class="profile-max">→ ${p.max} €</span></span>
      </div>`;
    }).join("");

    return `
      <div class="fare-card">
        <div class="fare-header">
          <div class="fare-carrier-badge" style="background:${st.bg};color:${st.text};border-color:${st.border}">
            <span class="carrier-dot" style="background:${st.dot}"></span>
            ${f.carrier}
          </div>
          <div class="fare-route-label">
            <span class="fare-station-name">${f.from}</span>
            <span class="fare-arrow-sm">→</span>
            <span class="fare-station-name">${f.to}</span>
          </div>
          <div class="fare-class-badge">${f.class}</div>
        </div>
        <div class="fare-profiles">
          ${profilesHtml}
        </div>
        <div class="fare-footer">
          <div class="fare-best-price">
            <span class="price-label">Prix plancher</span>
            <span class="price-big">${f.min_price} €</span>
          </div>
          <a class="book-btn" href="${bookUrl}" target="_blank" rel="noopener">Réserver →</a>
        </div>
      </div>
    `;
  }).join("");

  el.innerHTML = `
    <div class="summary-bar">${summaryHtml}</div>
    <div class="fare-info-note">
      Prix de référence issus des données ouvertes SNCF. Le prix final dépend de la disponibilité lors de la réservation.
    </div>
    ${faresHtml}
  `;

  alertCta.classList.remove("hidden");
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function openAlertModal() {
  if (!lastSearch) return;
  document.getElementById("modal-route-label").textContent =
    `${lastSearch.from.name} → ${lastSearch.to.name}`;
  document.getElementById("alert-modal").classList.remove("hidden");
}

function closeAlertModal() {
  document.getElementById("alert-modal").classList.add("hidden");
  document.getElementById("alert-max-price").value = "";
  document.getElementById("alert-email").value = "";
}

async function saveAlert() {
  if (!lastSearch) return;
  const maxPrice = parseFloat(document.getElementById("alert-max-price").value) || null;
  const email    = document.getElementById("alert-email").value.trim() || null;
  try {
    const res = await fetch(`${API}/api/alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        from_station: lastSearch.from.name,
        from_id: lastSearch.from.id,
        to_station: lastSearch.to.name,
        to_id: lastSearch.to.id,
        max_price: maxPrice,
        email,
      }),
    });
    if (res.ok) {
      closeAlertModal();
      showToast("✅ Alerte créée !");
      if (document.getElementById("tab-alerts").classList.contains("active")) loadAlerts();
    } else {
      const err = await res.json();
      alert("Erreur : " + (err.error || "Inconnue"));
    }
  } catch (_) {
    alert("Impossible de créer l'alerte.");
  }
}

async function loadAlerts() {
  const el = document.getElementById("alerts-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;
  try {
    const res = await fetch(`${API}/api/alerts?user_id=${userId}`);
    const data = await res.json();
    renderAlerts(data.alerts || []);
  } catch (_) {
    el.innerHTML = `<div class="empty-state"><p>Impossible de charger les alertes.</p></div>`;
  }
}

function renderAlerts(alerts) {
  const el = document.getElementById("alerts-list");
  if (!alerts.length) {
    el.innerHTML = `<div class="empty-state"><span>🔔</span><p>Aucune alerte.<br/>Faites une recherche et créez-en une !</p></div>`;
    return;
  }
  el.innerHTML = alerts.map(a => `
    <div class="alert-item" id="alert-${a.id}">
      <div style="flex:1">
        <div class="alert-route">${a.from_station} → ${a.to_station}</div>
      </div>
      ${a.max_price ? `<span class="alert-threshold">Seuil : ${a.max_price} €</span>` : ""}
      <button class="alert-delete-btn" onclick="deleteAlert('${a.id}')">Supprimer</button>
    </div>
  `).join("");
}

async function deleteAlert(id) {
  try {
    await fetch(`${API}/api/alerts?id=${id}&user_id=${userId}`, { method: "DELETE" });
    document.getElementById(`alert-${id}`)?.remove();
    if (!document.querySelector(".alert-item")) renderAlerts([]);
  } catch (_) { alert("Impossible de supprimer l'alerte."); }
}

// ── Trending ──────────────────────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById("trending-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;
  try {
    const res  = await fetch(`${API}/api/trending`);
    const data = await res.json();
    renderTrending(data);
  } catch (_) {
    el.innerHTML = `<div class="loading-state">Impossible de charger.</div>`;
  }
}

function renderTrending(routes) {
  const el = document.getElementById("trending-list");
  if (!routes.length) {
    el.innerHTML = `<div class="empty-state"><p>Pas encore de données.<br/>Revenez après quelques recherches !</p></div>`;
    return;
  }
  el.innerHTML = routes.map(r => `
    <div class="trending-card" onclick="prefillSearch('${r.from_station}', '${r.to_station}')">
      <div class="trending-route">${r.from_station} → ${r.to_station}</div>
      <div class="trending-searches">${r.searches} recherche${r.searches > 1 ? "s" : ""} cette semaine</div>
      ${r.best_price ? `<div class="trending-price">À partir de ~${Math.round(r.best_price)} €</div>` : ""}
    </div>
  `).join("");
}

function prefillSearch(from, to) {
  showTab("search");
  document.getElementById("input-from").value = from;
  document.getElementById("input-to").value = to;
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement("div");
  t.textContent = msg;
  Object.assign(t.style, {
    position: "fixed", bottom: "1.5rem", right: "1.5rem",
    background: "#111827", color: "white",
    padding: ".7rem 1.2rem", borderRadius: "8px",
    fontWeight: "600", fontSize: ".9rem", zIndex: "1000",
    boxShadow: "0 4px 24px rgba(0,0,0,.15)",
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  // Default date = tomorrow
  const d = new Date();
  d.setDate(d.getDate() + 1);
  document.getElementById("input-date").value =
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  document.querySelectorAll(".search-field input").forEach(inp =>
    inp.addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); })
  );
})();
