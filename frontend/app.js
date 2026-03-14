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
function autocomplete(field) {
  clearTimeout(autocompleteTimers[field]);
  const input = document.getElementById(`input-${field}`);
  const suggestionsEl = document.getElementById(`suggestions-${field}`);
  const q = input.value.trim();

  if (q.length < 2) {
    suggestionsEl.classList.add("hidden");
    if (field === "from") selectedFrom = null;
    else selectedTo = null;
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

  el.innerHTML = places.map(p => `
    <div class="suggestion-item" onclick="selectStation('${field}', ${JSON.stringify(p).replace(/"/g, "&quot;")})">
      <div class="station-name">${p.name}</div>
      <div class="station-label">${p.label}</div>
    </div>
  `).join("");
  el.classList.remove("hidden");
}

function selectStation(field, place) {
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
  const dateInput = document.getElementById("input-date").value;
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
  if (!dateInput) {
    showError("Veuillez choisir une date de voyage.");
    return;
  }

  setSearchLoading(true);

  try {
    const res = await fetch(`${API}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from_id: selectedFrom.id,
        to_id: selectedTo.id,
        from_name: selectedFrom.name,
        to_name: selectedTo.name,
        date: dateInput,
      }),
    });

    const data = await res.json();

    if (!res.ok) {
      showError(data.error || "Erreur lors de la recherche.");
      return;
    }

    lastSearch = {
      from: selectedFrom,
      to: selectedTo,
      date: dateInput,
    };

    renderResults(data.journeys, data.cached);
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

function formatTime(dt) {
  // dt format: "20260415T103000" → "10:30"
  if (!dt || dt.length < 13) return "--:--";
  return dt.substring(9, 11) + ":" + dt.substring(11, 13);
}

function formatDuration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h${m.toString().padStart(2, "0")}` : `${m} min`;
}

function buildBookingUrl(journey) {
  if (!lastSearch) return "https://www.sncf-connect.com";
  // Deep-link attempt to SNCF Connect (best effort)
  const from = encodeURIComponent(lastSearch.from.name);
  const to = encodeURIComponent(lastSearch.to.name);
  const date = lastSearch.date.replace(/-/g, "");
  return `https://www.sncf-connect.com/app/home/search?originLabel=${from}&destinationLabel=${to}&outwardDate=${date}&passengers=1`;
}

function renderResults(journeys, cached) {
  const el = document.getElementById("results-list");
  const titleEl = document.getElementById("results-title");
  const cacheBadge = document.getElementById("results-cache-badge");
  const resultsEl = document.getElementById("results-section");

  if (lastSearch) {
    titleEl.textContent = `${lastSearch.from.name} → ${lastSearch.to.name}`;
  }
  cacheBadge.classList.toggle("hidden", !cached);

  if (!journeys.length) {
    el.innerHTML = `<div class="empty-state"><span>🚫</span><p>Aucun trajet trouvé pour cette date.<br/>Essayez une autre date ou des gares différentes.</p></div>`;
    resultsEl.classList.remove("hidden");
    document.getElementById("alert-cta").classList.add("hidden");
    return;
  }

  el.innerHTML = journeys.map((j, i) => {
    const depTime = formatTime(j.departure);
    const arrTime = formatTime(j.arrival);
    const dur = formatDuration(j.duration_min);
    const trainLabels = j.sections.map(s => s.line || s.physical_mode).filter(Boolean);
    const uniqueLabels = [...new Set(trainLabels)].slice(0, 2);
    const bookUrl = buildBookingUrl(j);

    const priceBlock = j.fare_found && j.price !== null
      ? `<div class="price-amount">${j.price.toFixed(0)} €</div>
         <span class="price-from">à partir de</span>`
      : `<div class="price-unknown">Prix non disponible</div>`;

    const transfersBlock = j.transfers > 0
      ? `<span class="transfers-badge">${j.transfers} correspondance${j.transfers > 1 ? "s" : ""}</span>`
      : `<span style="font-size:.75rem;color:var(--green);font-weight:600;">Direct</span>`;

    return `
      <div class="journey-card">
        <div class="journey-times">
          <div class="time-block">
            <div class="time">${depTime}</div>
            <div class="station">${j.sections[0]?.from || lastSearch?.from?.name || ""}</div>
          </div>
          <div class="journey-line">
            <div class="journey-duration">${dur}</div>
            <div class="journey-track"></div>
            <div class="journey-meta">
              ${uniqueLabels.map(l => `<span class="train-label">${l}</span>`).join("")}
              ${transfersBlock}
            </div>
          </div>
          <div class="time-block">
            <div class="time">${arrTime}</div>
            <div class="station">${j.sections[j.sections.length-1]?.to || lastSearch?.to?.name || ""}</div>
          </div>
        </div>

        <div></div>

        <div class="journey-price">
          ${priceBlock}
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
  label.textContent = `${lastSearch.from.name} → ${lastSearch.to.name} · ${lastSearch.date}`;
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
        travel_date: lastSearch.date,
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
      ${r.avg_price ? `<div class="trending-price">À partir de ~${Math.round(r.avg_price)} €</div>` : ""}
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
  // Default date to tomorrow
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yyyy = tomorrow.getFullYear();
  const mm = String(tomorrow.getMonth() + 1).padStart(2, "0");
  const dd = String(tomorrow.getDate()).padStart(2, "0");
  document.getElementById("input-date").value = `${yyyy}-${mm}-${dd}`;

  // Set default active tab nav button
  document.getElementById("nav-search").classList.add("active");

  // Enter key triggers search
  document.querySelectorAll(".search-field input").forEach(inp => {
    inp.addEventListener("keydown", e => {
      if (e.key === "Enter") doSearch();
    });
  });
})();
