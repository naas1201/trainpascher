/**
 * TrainPascher — Frontend SPA
 */

const API = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
  ? "http://localhost:8787"
  : "https://trainpascher-worker.qmpro.workers.dev";

// ── Card config ───────────────────────────────────────────────────────────
const CARDS = {
  none:     { label: "Sans carte",          color: "#374151" },
  avantage: { label: "Carte Avantage",      color: "#1d4ed8" },
  etudiant: { label: "Étudiant / Apprenti", color: "#059669" },
};

// Short display names for profiles
const PROFILE_SHORT = {
  "Tarif Normal":                         "Tarif Normal",
  "Tarif Avantage":                       "Carte Avantage",
  "Tarif Réglementé":                     "Tarif réduit",
  "Tarif Elève - Etudiant - Apprenti":    "Étudiant / Apprenti",
  "Tarif Élève - Étudiant - Apprenti":    "Étudiant / Apprenti",
};

// Carrier display config
const CARRIER_STYLE = {
  "OUIGO":                  { bg: "#fce7f3", text: "#9d174d", border: "#f9a8d4" },
  "OUIGO TRAIN CLASSIQUE":  { bg: "#fce7f3", text: "#9d174d", border: "#f9a8d4" },
  "TGV INOUI":              { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe" },
  "INOUI":                  { bg: "#eff6ff", text: "#1d4ed8", border: "#bfdbfe" },
  "TER NA":                 { bg: "#f0fdf4", text: "#15803d", border: "#bbf7d0" },
  "Intercités":             { bg: "#fff7ed", text: "#c2410c", border: "#fdba74" },
};
function carrierStyle(c) {
  return CARRIER_STYLE[c] || { bg: "#f9fafb", text: "#374151", border: "#e5e7eb" };
}

// ── State ─────────────────────────────────────────────────────────────────
let selectedFrom = null;
let selectedTo   = null;
let lastSearch   = null;
let turnstileToken = null;
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
  // Re-render results with new card highlight if already showing
  if (lastSearch) highlightActiveCard();
});

// Restore saved card selection
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
      <span class="sug-label">${p.label || p.id}</span>
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

  setLoading(true);

  try {
    const body = {
      from_id:        selectedFrom.id,
      from_name:      selectedFrom.name,
      from_city:      selectedFrom.city,
      to_id:          selectedTo.id,
      to_name:        selectedTo.name,
      to_city:        selectedTo.city,
      date,
      card_type:      selectedCard,
      turnstile_token: turnstileToken || "dummy",
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
  const listEl    = document.getElementById("results-list");
  const section   = document.getElementById("results-section");
  const titleEl   = document.getElementById("results-title");
  const dateEl    = document.getElementById("results-date-label");
  const cacheBadge = document.getElementById("cache-badge");

  titleEl.textContent = `${data.from_name} → ${data.to_name}`;
  const d = new Date(date + "T12:00:00Z");
  dateEl.textContent = d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" });
  cacheBadge.classList.toggle("hidden", !data.cached);
  section.classList.remove("hidden");

  // Nav error notice
  const navErrHtml = data.nav_error
    ? `<div class="nav-error-notice">⚠️ Horaires temporairement indisponibles — affichage des tarifs de référence uniquement.</div>`
    : "";

  // No journeys + no fares
  if (!data.journeys.length && !data.main_fares.length) {
    listEl.innerHTML = navErrHtml + `<div class="empty-state"><span>🚫</span><p>Aucun résultat pour ce trajet.<br/>Essayez avec des noms de gares plus précis.</p></div>`;
    document.getElementById("alert-cta").classList.add("hidden");
    return;
  }

  const html = [];
  if (navErrHtml) html.push(navErrHtml);

  if (data.journeys.length) {
    data.journeys.forEach(j => html.push(renderJourneyCard(j)));
  } else if (data.main_fares.length) {
    // No Navitia results but we have fare reference data
    html.push(renderFareOnlyCard(data));
  }

  listEl.innerHTML = html.join("");
  document.getElementById("alert-cta").classList.toggle("hidden", !data.main_fares.length && !data.journeys.length);
  highlightActiveCard();
}

// ── Journey card ──────────────────────────────────────────────────────────
function renderJourneyCard(j) {
  const dur = formatDuration(j.dur_min);
  const transfers = j.transfers === 0 ? "Direct" : `${j.transfers} correspondance${j.transfers > 1 ? "s" : ""}`;

  // Section pills
  const sectionPills = j.sections.map(s => {
    const st = carrierStyle(s.carrier);
    return `<span class="section-pill" style="background:${st.bg};color:${st.text};border-color:${st.border}">${s.carrier}</span>`;
  }).join(`<span class="section-arrow">›</span>`);

  // Section breakdown (only shown if >1 section)
  let sectionsHtml = "";
  if (j.sections.length > 1 || j.sections.some(s => s.fares && s.fares.length)) {
    sectionsHtml = `<div class="sections-breakdown">` +
      j.sections.map(s => {
        const st = carrierStyle(s.carrier);
        const sDur = formatDuration(s.dur_min);
        let fareLine = "";
        if (s.is_tgv && s.fares && s.fares.length) {
          const best = s.fares[0];
          fareLine = `<div class="section-fare">
            <div class="section-fare-profiles" data-segment-fares='${JSON.stringify(s.fares)}'>
              ${renderProfileRows(s.fares, true)}
            </div>
          </div>`;
        } else if (!s.is_tgv) {
          const est = s.ter_estimate;
          fareLine = est
            ? `<div class="section-fare ter-fare">
                TER · ~${est.price_min}€ – ${est.price_max}€
                <span class="ter-est-badge" title="Estimation basée sur ${est.km_rail} km. Prix exact sur SNCF Connect.">estimation ℹ</span>
               </div>`
            : `<div class="section-fare ter-fare">TER · prix variable</div>`;
        }
        return `<div class="section-row">
          <div class="section-header">
            <span class="section-badge" style="background:${st.bg};color:${st.text};border:1px solid ${st.border}">${s.carrier}</span>
            <span class="section-times">${s.dep} → ${s.arr}</span>
            <span class="section-dur">${sDur}</span>
          </div>
          <div class="section-stations">${s.from} → ${s.to}</div>
          ${fareLine}
        </div>`;
      }).join("") +
      `</div>`;
  }

  // Global fares (for direct/simple journeys)
  let globalFaresHtml = "";
  if (j.sections.length === 1 && j.sections[0].fares && j.sections[0].fares.length) {
    globalFaresHtml = `<div class="journey-fares" data-fares='${JSON.stringify(j.sections[0].fares)}'>
      ${renderProfileRows(j.sections[0].fares)}
    </div>`;
  } else if (j.sections.length === 1 && (!j.sections[0].fares || !j.sections[0].fares.length)) {
    const est = j.sections[0]?.ter_estimate;
    globalFaresHtml = est
      ? `<div class="journey-fares ter-fare-block">
          🚆 TER · Tarif estimé : <strong>~${est.price_min} – ${est.price_max} €</strong>
          <span class="ter-est-badge" title="Basé sur ${est.km_r}km — confirmation sur SNCF Connect.">estimation ℹ</span>
         </div>`
      : `<div class="journey-fares ter-fare-block">
          🚆 TER — Prix variable, voir sur SNCF Connect
         </div>`;
  }

  const priceChip = j.total_min_price !== null
    ? `<span class="price-chip ${j.price_is_estimate ? 'price-chip--estimate' : ''}">
        ${j.price_is_estimate ? '~' : 'à partir de'} <strong>${j.total_min_price} €</strong>
        ${j.price_is_estimate ? '<span class="price-chip-hint" title="Estimation TER basée sur la distance (±20%). Prix exact sur SNCF Connect.">ℹ</span>' : ''}
       </span>`
    : `<span class="price-chip price-chip--ter">Prix TER</span>`;

  return `
    <div class="journey-card">
      <div class="journey-header">
        <div class="journey-times">
          <span class="time-dep">${j.dep_time}</span>
          <span class="time-line"><span class="time-dot"></span><span class="time-track"></span><span class="time-dot"></span></span>
          <span class="time-arr">${j.arr_time}</span>
        </div>
        <div class="journey-meta">
          <span class="journey-dur">${dur}</span>
          <span class="journey-transfers ${j.transfers === 0 ? 'direct' : ''}">${transfers}</span>
        </div>
        ${priceChip}
      </div>
      <div class="journey-carriers">${sectionPills}</div>
      ${sectionsHtml}
      ${globalFaresHtml}
      <div class="journey-footer">
        <a class="book-btn" href="${j.booking_url}" target="_blank" rel="noopener">
          Voir &amp; réserver sur SNCF Connect →
        </a>
      </div>
    </div>`;
}

// Fare-only card (no Navitia, only ODS reference fares)
function renderFareOnlyCard(data) {
  return `
    <div class="journey-card fare-only-card">
      <div class="fare-only-header">
        <span class="fare-only-icon">💰</span>
        <div>
          <div class="fare-only-title">Tarifs de référence</div>
          <div class="fare-only-sub">Horaires temporairement indisponibles — voici les fourchettes de prix habituelles</div>
        </div>
      </div>
      <div class="journey-fares" data-fares='${JSON.stringify(data.main_fares)}'>
        ${renderProfileRows(data.main_fares)}
      </div>
      <div class="journey-footer">
        <a class="book-btn" href="${data.booking_url}" target="_blank" rel="noopener">
          Rechercher les billets sur SNCF Connect →
        </a>
      </div>
    </div>`;
}

// ── Fare profile rows (grouped by carrier) ────────────────────────────────
function renderProfileRows(fares, compact = false) {
  if (!fares || !fares.length) return "";
  return fares.map(f => {
    const st = carrierStyle(f.carrier);

    // OUIGO note: no reduction cards
    const ouigoNote = f.ouigo_no_discount
      ? `<div class="ouigo-no-discount">ℹ OUIGO n'applique pas les cartes de réduction — prix déjà optimisé</div>`
      : "";

    const profilesHtml = (f.profiles || [])
      // Only show profiles relevant to the current card selector (none/avantage/etudiant)
      .filter(p => ["none","avantage","etudiant"].includes(p.card_key))
      .map(p => {
        const short = PROFILE_SHORT[p.name] || p.name.replace("Tarif ", "");
        const estBadge = p.estimated
          ? `<span class="est-badge" title="Estimation basée sur les remises SNCF publiées (−30% Avantage, −25% Étudiant). Confirmez sur SNCF Connect.">~estimé</span>`
          : "";
        return `<div class="profile-row" data-card-key="${p.card_key}">
          <span class="profile-name">${short}${estBadge}</span>
          <span class="profile-range">${p.min} € <span class="profile-max">— ${p.max} €</span></span>
        </div>`;
      }).join("");

    return `<div class="fare-group ${compact ? 'fare-group--compact' : ''}">
      <div class="fare-carrier-tag" style="background:${st.bg};color:${st.text};border:1px solid ${st.border}">
        ${f.carrier} · ${f.class}
      </div>
      ${ouigoNote}
      <div class="fare-profiles-list">${profilesHtml}</div>
    </div>`;
  }).join("");
}

// ── Highlight active card in all fare tables ──────────────────────────────
function highlightActiveCard() {
  document.querySelectorAll(".profile-row").forEach(row => {
    const isMatch = row.dataset.cardKey === selectedCard;
    row.classList.toggle("profile-highlighted", isMatch);
    // Show/hide the "✓ Votre tarif" badge
    let badge = row.querySelector(".your-fare-badge");
    if (isMatch) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "your-fare-badge";
        badge.textContent = "✓ votre tarif";
        row.querySelector(".profile-name")?.appendChild(badge);
      }
    } else {
      badge?.remove();
    }
  });
}

function formatDuration(min) {
  if (!min) return "";
  const h = Math.floor(min / 60), m = min % 60;
  return h > 0 ? `${h}h${m > 0 ? m.toString().padStart(2, "0") : ""}` : `${m}min`;
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
  document.getElementById("modal-route").textContent =
    `${lastSearch.from.name} → ${lastSearch.to.name}`;
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
        card_type: selectedCard,
      }),
    });
    if (res.ok) {
      closeAlertModal();
      toast("✅ Alerte créée !");
    }
  } catch (_) { alert("Impossible de créer l'alerte."); }
}

async function loadAlerts() {
  const el = document.getElementById("alerts-list");
  el.innerHTML = `<div class="loading-state">Chargement…</div>`;
  try {
    const res = await fetch(`${API}/api/alerts?user_id=${userId}`);
    const d   = await res.json();
    const alerts = d.alerts || [];
    if (!alerts.length) {
      el.innerHTML = `<div class="empty-state"><span>🔔</span><p>Aucune alerte.<br/>Faites une recherche et créez-en une !</p></div>`;
      return;
    }
    el.innerHTML = alerts.map(a => `
      <div class="alert-item" id="al-${a.id}">
        <div class="alert-route">${a.from_station} → ${a.to_station}</div>
        ${a.max_price ? `<span class="alert-badge">≤ ${a.max_price} €</span>` : ""}
        ${a.card_type && a.card_type !== "none" ? `<span class="alert-badge alt">${CARDS[a.card_type]?.label || a.card_type}</span>` : ""}
        <button class="alert-del" onclick="deleteAlert('${a.id}')">Supprimer</button>
      </div>`).join("");
  } catch (_) {
    el.innerHTML = `<div class="loading-state">Impossible de charger les alertes.</div>`;
  }
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
    const res  = await fetch(`${API}/api/trending`);
    const rows = await res.json();
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state"><p>Pas encore de données.<br/>Revenez après quelques recherches !</p></div>`;
      return;
    }
    el.innerHTML = `<div class="trending-grid">` + rows.map(r => `
      <div class="trending-card" onclick="prefillSearch('${r.from_station}','${r.to_station}')">
        <div class="trending-route">${r.from_station} → ${r.to_station}</div>
        <div class="trending-stats">${r.searches} recherche${r.searches > 1 ? "s" : ""}</div>
        ${r.best_price ? `<div class="trending-price">~${Math.round(r.best_price)} €</div>` : ""}
      </div>`).join("") + `</div>`;
  } catch (_) {
    el.innerHTML = `<div class="loading-state">Impossible de charger.</div>`;
  }
}

function prefillSearch(from, to) {
  showTab("search");
  document.getElementById("input-from").value = from;
  document.getElementById("input-to").value   = to;
}

// ── Toast ─────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = Object.assign(document.createElement("div"), { textContent: msg, className: "toast" });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Init ──────────────────────────────────────────────────────────────────
(function init() {
  // Default date = tomorrow
  const d = new Date(); d.setDate(d.getDate() + 1);
  document.getElementById("input-date").value =
    `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;

  // Enter key triggers search
  ["input-from","input-to","input-date"].forEach(id =>
    document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") doSearch(); })
  );

  renderQuickRoutes();
})();
