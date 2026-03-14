/**
 * TrainPascher — Frontend SPA
 * Talks to the Cloudflare Worker API
 */

// ── Config ──────────────────────────────────────────────────────────────────
// Replace with your deployed worker URL, or use localhost for dev
const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:8787"
  : "https://trainpascher-worker.qmpro.workers.dev";

// ── State ────────────────────────────────────────────────────────────────────
let selectedFrom = null; // { id, name, label }
let selectedTo = null;
let lastSearch = null;   // cache of latest search params for alert modal
let autocompleteTimers = {};
const suggestionCache = { from: [], to: [] }; // stores last results by field
let userId = localStorage.getItem("tp_user_id");
if (!userId) {
  userId = crypto.randomUUID();
  localStorage.setItem("tp_user_id", userId);
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.getElementById(`tab-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");

  if (name === "alerts") loadAlerts();
  if (name === "trending") loadTrending();
}

// ── Autocomplete ─────────────────────────────────────────────────────────────
function onStationInput(field) {
  clearTimeout(autocompleteTimers[field]);
  const input = document.getElementById(`input-${field}`);
  const suggestionsEl = document.getElementById(`suggestions-${field}`);
  const q = input.value.trim();

  // Clear selection when user types again
  if (field === "from") selectedFrom = null;
  else selectedTo = null;

  if (q.length < 2) {
    suggestionsEl.classList.add("hidden");
    return;
  }

  autocompleteTimers[field] = setTimeout(async () => {
    try {
      const res = await fetch(`${API}/api/autocomplete?q=${encodeURIComponent(q)}`);
      const places = await res.json();
      renderSuggestions(field, places);
    } catch (_) {
      suggestionsEl.classList.add("hidden");
    }
  }, 280);
}

function renderSuggestions(field, places) {
  const el = document.getElementById(`suggestions-${field}`);
  if (!places.length) { el.classList.add("hidden"); return; }

  // Store results in cache so onclick can look up by index (no inline JSON)
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
  const fromInput = document.getElementById("input-from");
  const toInput = document.getElementById("input-to");
  const tmpVal = fromInput.value;
  fromInput.value = toInput.value;
  toInput.value = tmpVal;
  const tmpSel = selectedFrom;
  selectedFrom = selectedTo;
  selectedTo = tmpSel;
}

// Close suggestions on outside click
document.addEventListener("click", (e) => {
  if (!e.target.closest(".autocomplete-wrap")) {
    document.querySelectorAll(".suggestions").forEach(s => s.classList.add("hidden"));
  }
});

// ── Search ────────────────────────────────────────────────────────────────────
async function doSearch() {
  const errorEl = document.getElementById("error-section");
  const resultsEl = document.getElementById("results-section");

  errorEl.classList.add("hidden");
  resultsEl.classList.add("hidden");

  if (!selectedFrom) {
    showError("Veuillez sélectionner une gare de départ dans la liste.");
    return;
  }
  if (!selectedTo) {
    showError("Veuillez sélectionner une gare d'arrivée dans la liste.");
    return;
  }

  setSearchLoading(true);

  try {
    const res = await fetch(`${API}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_name: selectedFrom.name,
        to_name: selectedTo.name,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Erreur lors de la recherche.");
      return;
    }

    lastSearch = { from: selectedFrom, to: selectedTo };
    renderResults(data.fares, data.cached);
  } catch (err) {
    showError("Impossible de contacter le serveur. Vérifiez votre connexion.");
  } finally {
    setSearchLoading(false);
  }
}

function setSearchLoading(loading) {
  const btn = document.querySelector(".search-btn");
  const text = document.getElementById("search-btn-text");
  const spinner = document.getElementById("search-spinner");
  btn.disabled = loading;
  text.textContent = loading ? "Recherche…" : "Rechercher";
  spinner.classList.toggle("hidden", !loading);
}

function showError(msg) {
  const el = document.getElementById("error-section");
  el.textContent = "⚠️ " + msg;
  el.classList.remove("hidden");
}

const CARRIER_COLORS = {
  "OUIGO": { bg: "#fce7f3", text: "#be185d", border: "#fbcfe8" },
  "TGV INOUI": { bg: "#e0f2fe", text: "#0369a1", border: "#bae6fd" },
  "INTERCITES": { bg: "#fef9c3", text: "#854d0e", border: "#fef08a" },
};

function carrierStyle(carrier) {
  const c = Object.entries(CARRIER_COLORS).find(([k]) => carrier.includes(k));
  return c ? c[1] : { bg: "var(--gray-100)", text: "var(--gray-700)", border: "var(--gray-200)" };
}

function buildBookingUrl(carrier) {
  if (!lastSearch) return "https://www.sncf-connect.com";
  const from = encodeURIComponent(lastSearch.from.name);
  const to = encodeURIComponent(lastSearch.to.name);
  if (carrier && carrier.includes("OUIGO")) {
    return `https://www.ouigo.com`;
  }
  return `https://www.sncf-connect.com/app/home/search?originLabel=${from}&destinationLabel=${to}&passengers=1`;
}

function renderResults(fares, cached) {
  const el = document.getElementById("results-list");
  const titleEl = document.getElementById("results-title");
  const cacheBadge = document.getElementById("results-cache-badge");
  const resultsEl = document.getElementById("results-section");

  if (lastSearch) {
    titleEl.textContent = `${lastSearch.from.name} → ${lastSearch.to.name}`;
  }
  cacheBadge.classList.toggle("hidden", !cached);

  if (!fares || !fares.length) {
    el.innerHTML = `<div class="empty-state"><span>🚫</span><p>Aucune offre trouvée pour ce trajet.<br/>Essayez des noms de gares différents.</p></div>`;
    resultsEl.classList.remove("hidden");
    document.getElementById("alert-cta").classList.add("hidden");
    return;
  }

  el.innerHTML = fares.map((f) => {
    const style = carrierStyle(f.carrier);
    const bookUrl = buildBookingUrl(f.carrier);

    return `
      <div class="journey-card fare-card">
        <div class="fare-carrier" style="background:${style.bg};color:${style.text};border-color:${style.border}">
          ${f.carrier}
        </div>
        <div class="fare-route">
          <span class="fare-station">${f.from}</span>
          <span class="fare-arrow">→</span>
          <span class="fare-station">${f.to}</span>
          <span class="fare-class-badge">${f.class}</span>
        </div>
        <div class="journey-price">
          <div class="price-amount">${f.min_price} €</div>
          <span class="price-from">à partir de · jusqu'à ${f.max_price} €</span>
          <a class="book-btn" href="${bookUrl}" target="_blank" rel="noopener">Réserver →</a>
        </div>
      </div>
    `;
  }).join("");

  resultsEl.classList.remove("hidden");
  document.getElementById("alert-cta").classList.remove("hidden");
}

// ── Alerts ────────────────────────────────────────────────────────────────────
function openAlertModal() {
  if (!lastSearch) return;
  const label = document.getElementById("modal-route-label");
  label.textContent = `${lastSearch.from.name} → ${lastSearch.to.name}`;
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
  const email = document.getElementById("alert-email").value.trim() || null;

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
      // Reload alerts list if tab visible
      if (document.getElementById("tab-alerts").classList.contains("active")) {
        loadAlerts();
      }
    } else {
      const err = await res.json();
      alert("Erreur : " + (err.error || "Inconnue"));
    }
  } catch (_) {
    alert("Impossible de créer l'alerte. Vérifiez votre connexion.");
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
    el.innerHTML = `
      <div class="empty-state">
        <span>🔔</span>
        <p>Aucune alerte pour l'instant.<br/>Faites une recherche et créez votre première alerte !</p>
      </div>`;
    return;
  }

  el.innerHTML = alerts.map(a => `
    <div class="alert-item" id="alert-${a.id}">
      <div style="flex:1">
        <div class="alert-route">${a.from_station} → ${a.to_station}</div>
        <div class="alert-date">📅 ${a.travel_date}</div>
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
    // Check if list is now empty
    if (!document.querySelector(".alert-item")) {
      renderAlerts([]);
    }
  } catch (_) {
    alert("Impossible de supprimer l'alerte.");
  }
}

// ── Trending ──────────────────────────────────────────────────────────────────
async function loadTrending() {
  const el = document.getElementById("trending-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;

  try {
    const res = await fetch(`${API}/api/trending`);
    const data = await res.json();
    renderTrending(data);
  } catch (_) {
    el.innerHTML = `<div class="loading-state">Impossible de charger les tendances.</div>`;
  }
}

function renderTrending(routes) {
  const el = document.getElementById("trending-list");

  if (!routes.length) {
    el.innerHTML = `<div class="empty-state"><p>Pas encore de données de tendances.<br/>Revenez après quelques recherches !</p></div>`;
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
    fontWeight: "600", fontSize: ".9rem",
    zIndex: "1000", boxShadow: "0 4px 24px rgba(0,0,0,.15)",
    animation: "fadeIn .2s ease",
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────────
(function init() {
  document.getElementById("nav-search").classList.add("active");

  // Enter key on station inputs triggers search
  document.querySelectorAll(".search-field input").forEach(inp => {
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") doSearch();
    });
  });
})();
