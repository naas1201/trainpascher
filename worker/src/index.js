/**
 * TrainPascher — SNCF Ticket Hunter
 * Cloudflare Worker
 *   - Navitia (api.sncf.com/v1) : journey schedules, autocomplete
 *   - data.sncf.com (Opendatasoft) : fare reference data per route + profile
 */

import { createClient } from "@libsql/client/web";

// ── Constants ─────────────────────────────────────────────────────────────
const NAVITIA_BASE   = "https://api.sncf.com/v1/coverage/sncf";
const ODS_BASE       = "https://data.sncf.com/api/explore/v2.1/catalog/datasets";
const TURNSTILE_URL  = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Navitia commercial modes that are in the ODS tarifs dataset
const TGV_MODES = new Set(["TGV INOUI", "OUIGO", "OUIGO TRAIN CLASSIQUE", "INOUI"]);

// Map card type → ODS profile name
const CARD_PROFILE = {
  none:        "Tarif Normal",
  avantage:    "Tarif Avantage",
  etudiant:    "Tarif Elève - Etudiant - Apprenti",
  reglemente:  "Tarif Réglementé",
};

// ── CORS ──────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}
function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function navitiaAuth(key) {
  return { Authorization: `Basic ${btoa(key + ":")}` };
}
function odsAuth(key) {
  return { Authorization: `Apikey ${key}` };
}

// "Bordeaux Saint-Jean (Bordeaux)" → "Bordeaux"
// "Paris - Montparnasse - Hall 1 & 2 (Paris)" → "Paris"
// "Royan (Royan)" → "Royan"
function cityFromNavitiaName(name) {
  const m = name.match(/\(([^)]+)\)\s*$/);
  if (m) return m[1];
  // Fallback: first word
  const first = name.split(/[\s\-–]+/)[0];
  return first;
}

// "Paris" → first meaningful word (for ODS search)
function safeOdsKeyword(str) {
  return str.replace(/"/g, "").replace(/[^\w\sàâäéèêëîïôùûüçœ'-]/gi, "").trim();
}

// Format Navitia datetime "20260320T074000" → { date: "2026-03-20", time: "07:40" }
function parseNavDt(dt) {
  if (!dt || dt.length < 13) return { date: "", time: "" };
  return {
    date: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
    time: `${dt.slice(9, 11)}:${dt.slice(11, 13)}`,
  };
}

// "2026-03-20" → "20260320T060000"
function toNavDt(date, time = "060000") {
  return date.replace(/-/g, "") + "T" + time;
}

// date ± N days
function offsetDate(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Navitia API ───────────────────────────────────────────────────────────
async function navitiaPlaces(q, key) {
  const url = `${NAVITIA_BASE}/places?q=${encodeURIComponent(q)}&type[]=stop_area&count=8`;
  const res = await fetch(url, { headers: navitiaAuth(key) });
  if (!res.ok) throw new Error(`Navitia places ${res.status}`);
  const data = await res.json();
  return (data.places || []).map(p => {
    // name format: "StationName (City)" or just "StationName"
    const raw = p.name || p.stop_area?.name || "";
    const cleanName = raw.replace(/\s*\([^)]*\)\s*$/, "").trim() || raw;
    const city = cityFromNavitiaName(raw);
    return {
      id: p.id,                       // "stop_area:SNCF:87491803"
      name: cleanName,                // "Royan"
      navitia_name: raw,              // "Royan (Royan)" — used for ODS city extraction
      city,                           // "Royan"
      label: cleanName,
    };
  });
}

async function navitiaJourneys(fromId, toId, date, key, count = 5) {
  const datetime = toNavDt(date);
  const url =
    `${NAVITIA_BASE}/journeys` +
    `?from=${encodeURIComponent(fromId)}` +
    `&to=${encodeURIComponent(toId)}` +
    `&datetime=${datetime}` +
    `&count=${count}` +
    `&data_freshness=base_schedule` +
    `&max_duration_to_pt=0`;
  const res = await fetch(url, { headers: navitiaAuth(key) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Navitia journeys ${res.status}: ${body.slice(0, 100)}`);
  }
  const data = await res.json();
  if (data.error) throw new Error(`Navitia: ${data.error.message || data.error.id}`);
  return data.journeys || [];
}

// ── ODS fare lookup ───────────────────────────────────────────────────────
async function odsFares(fromCity, toCity, odsKey) {
  const f = safeOdsKeyword(fromCity);
  const t = safeOdsKeyword(toCity);
  const url =
    `${ODS_BASE}/tarifs-tgv-inoui-ouigo/records` +
    `?limit=100` +
    `&select=transporteur,gare_origine,gare_destination,classe,profil_tarifaire,prix_minimum,prix_maximum` +
    `&where=search(gare_origine,"${encodeURIComponent(f)}")` +
    `%20AND%20search(gare_destination,"${encodeURIComponent(t)}")`;
  const res = await fetch(url, { headers: odsAuth(odsKey) });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

const PROFILE_ORDER = [
  "Tarif Normal",
  "Tarif Avantage",
  "Tarif Réglementé",
  "Tarif Elève - Etudiant - Apprenti",
  "Tarif Élève - Étudiant - Apprenti",
];

function groupFares(records) {
  const grouped = {};
  for (const r of records) {
    const key = `${r.transporteur}|${r.classe}|${r.gare_origine}|${r.gare_destination}`;
    if (!grouped[key]) {
      grouped[key] = {
        carrier: r.transporteur,
        from: r.gare_origine,
        to: r.gare_destination,
        class: r.classe === "1" ? "1ère" : "2ème",
        profiles: [],
        min_price: r.prix_minimum,
        max_price: r.prix_maximum,
      };
    } else {
      grouped[key].min_price = Math.min(grouped[key].min_price, r.prix_minimum);
      grouped[key].max_price = Math.max(grouped[key].max_price, r.prix_maximum);
    }
    grouped[key].profiles.push({
      card_key: Object.entries(CARD_PROFILE).find(([, v]) => v === r.profil_tarifaire)?.[0] || "none",
      name: r.profil_tarifaire,
      min: r.prix_minimum,
      max: r.prix_maximum,
    });
  }
  return Object.values(grouped).map(g => {
    g.profiles.sort((a, b) => {
      const ai = PROFILE_ORDER.indexOf(a.name); const bi = PROFILE_ORDER.indexOf(b.name);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    return g;
  }).sort((a, b) => a.min_price - b.min_price);
}

// ── Journey parser ────────────────────────────────────────────────────────
function parseJourneys(navJourneys, odsFaresBySegment) {
  return navJourneys
    .filter(j => j.type !== "non_pt")
    .map(j => {
      const dep = parseNavDt(j.departure_date_time);
      const arr = parseNavDt(j.arrival_date_time);
      const dur_min = Math.round((j.duration || 0) / 60);

      const sections = (j.sections || [])
        .filter(s => s.type === "public_transport")
        .map(s => {
          const mode = s.display_informations?.commercial_mode || "Train";
          const fromName = s.from?.name || "";
          const toName   = s.to?.name   || "";
          const fromCity = cityFromNavitiaName(fromName);
          const toCity   = cityFromNavitiaName(toName);
          const sdep = parseNavDt(s.departure_date_time);
          const sarr = parseNavDt(s.arrival_date_time);
          const sDurMin = Math.round(((s.duration || 0)) / 60);
          const isTgv = TGV_MODES.has(mode);
          const segKey = `${fromCity.toLowerCase()}:${toCity.toLowerCase()}`;
          const fares = isTgv ? (odsFaresBySegment[segKey] || []) : [];

          return {
            from: fromName.replace(/\s*\([^)]*\)$/, ""),
            to:   toName.replace(/\s*\([^)]*\)$/, ""),
            from_city: fromCity,
            to_city: toCity,
            dep: sdep.time,
            arr: sarr.time,
            dur_min: sDurMin,
            carrier: mode,
            headsign: s.display_informations?.headsign || "",
            is_tgv: isTgv,
            fares,                          // ODS fares for this leg
          };
        });

      // Best fare = min across all TGV sections, if any
      const tgvFares = sections.flatMap(s => s.fares);
      const totalMinPrice = tgvFares.length
        ? tgvFares.reduce((m, f) => Math.min(m, f.min_price), Infinity)
        : null;

      // Booking URL deep-link
      const fromLabel = sections[0]?.from || dep.date;
      const toLabel   = sections[sections.length - 1]?.to || arr.date;
      const dateStr   = dep.date.replace(/-/g, "");
      const bookUrl =
        `https://www.sncf-connect.com/app/home/search` +
        `?originLabel=${encodeURIComponent(fromLabel)}` +
        `&destinationLabel=${encodeURIComponent(toLabel)}` +
        `&outwardDate=${dateStr}&passengers=1`;

      return {
        dep_time: dep.time,
        arr_time: arr.time,
        dep_date: dep.date,
        arr_date: arr.date,
        dur_min,
        transfers: j.nb_transfers || 0,
        sections,
        total_min_price: totalMinPrice,
        booking_url: bookUrl,
      };
    })
    .sort((a, b) => {
      if (a.dep_date !== b.dep_date) return a.dep_date < b.dep_date ? -1 : 1;
      return a.dep_time < b.dep_time ? -1 : 1;
    });
}

// ── Turnstile ─────────────────────────────────────────────────────────────
async function validateTurnstile(token, secret) {
  // Test/dummy secret: always pass
  if (!secret || !token || secret.startsWith("1x000000000000000000000000000")) return true;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const res = await fetch(TURNSTILE_URL, { method: "POST", body: form });
  const data = await res.json();
  return !!data.success;
}

// ── Turso ─────────────────────────────────────────────────────────────────
function db(env) {
  return createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
}

// ── CORS preflight ─────────────────────────────────────────────────────────
function preflight(origin) {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// ── /api/autocomplete ─────────────────────────────────────────────────────
async function handleAutocomplete(req, env) {
  const q = (new URL(req.url).searchParams.get("q") || "").trim();
  if (q.length < 2) return json([]);

  const cacheKey = `ac3:${q.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json(cached);

  const places = await navitiaPlaces(q, env.NAVITIA_KEY);
  await env.CACHE.put(cacheKey, JSON.stringify(places), { expirationTtl: 86400 });
  return json(places);
}

// ── /api/search ───────────────────────────────────────────────────────────
async function handleSearch(req, env, origin) {
  const body = await req.json().catch(() => ({}));
  const { from_id, from_name, from_city, to_id, to_name, to_city, date, card_type = "none", turnstile_token } = body;

  if (!from_id || !to_id || !date) {
    return json({ error: "from_id, to_id, date requis" }, 400, origin);
  }

  // Turnstile validation (soft — test key always passes)
  const tsValid = await validateTurnstile(turnstile_token, env.TURNSTILE_SECRET);
  if (!tsValid) return json({ error: "Vérification de sécurité échouée." }, 403, origin);

  // KV cache key (card-type-independent — all profiles returned)
  const cacheKey = `v4:${from_id}:${to_id}:${date}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json({ ...cached, cached: true }, 200, origin);

  // ── 1. Navitia journeys ──────────────────────────────────────────────
  let navJourneys = [];
  let navError = null;
  try {
    navJourneys = await navitiaJourneys(from_id, to_id, date, env.NAVITIA_KEY);
  } catch (e) {
    navError = e.message;
  }

  // ── 2. ODS fare lookup for each unique TGV city-pair in results ──────
  const cityPairs = new Set();
  // Always add the main route pair
  const fromCityMain = from_city || cityFromNavitiaName(from_name || "");
  const toCityMain   = to_city   || cityFromNavitiaName(to_name   || "");
  cityPairs.add(`${fromCityMain.toLowerCase()}:${toCityMain.toLowerCase()}`);
  // Add pairs from journey sections
  for (const j of navJourneys) {
    for (const s of (j.sections || []).filter(s => s.type === "public_transport")) {
      if (TGV_MODES.has(s.display_informations?.commercial_mode)) {
        const fc = cityFromNavitiaName(s.from?.name || "");
        const tc = cityFromNavitiaName(s.to?.name   || "");
        cityPairs.add(`${fc.toLowerCase()}:${tc.toLowerCase()}`);
      }
    }
  }

  // Fetch ODS fares for all city pairs in parallel
  const odsFaresBySegment = {};
  await Promise.all([...cityPairs].map(async (pair) => {
    const [fc, tc] = pair.split(":");
    try {
      const records = await odsFares(fc, tc, env.SNCF_API_KEY);
      if (records.length) odsFaresBySegment[pair] = groupFares(records);
    } catch (_) {}
  }));

  // ── 3. Parse journeys into UI-ready structure ────────────────────────
  const journeys = parseJourneys(navJourneys, odsFaresBySegment);

  // ── 4. Main route ODS fares (for display even with no Navitia) ───────
  const mainFares = odsFaresBySegment[`${fromCityMain.toLowerCase()}:${toCityMain.toLowerCase()}`] || [];

  // ── 5. Determine overall min price ───────────────────────────────────
  const overallMin = journeys.length
    ? journeys.reduce((m, j) => j.total_min_price !== null ? Math.min(m, j.total_min_price) : m, Infinity)
    : (mainFares.length ? mainFares[0].min_price : null);

  // ── 6. Booking URL ────────────────────────────────────────────────────
  const dateStr = date.replace(/-/g, "");
  const bookingUrl =
    `https://www.sncf-connect.com/app/home/search` +
    `?originLabel=${encodeURIComponent(from_name || fromCityMain)}` +
    `&destinationLabel=${encodeURIComponent(to_name || toCityMain)}` +
    `&outwardDate=${dateStr}&passengers=1`;

  const result = {
    journeys,
    main_fares: mainFares,         // fares for full O/D pair (reference)
    overall_min_price: isFinite(overallMin) ? overallMin : null,
    has_tgv_service: mainFares.length > 0,
    from_name: from_name || fromCityMain,
    to_name: to_name || toCityMain,
    date,
    booking_url: bookingUrl,
    nav_error: navError,
  };

  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

  // Log to Turso
  try {
    await db(env).execute({
      sql: `INSERT OR IGNORE INTO search_log
            (id, from_station, to_station, travel_date, min_price, searched_at, card_type)
            VALUES (?,?,?,?,?,?,?)`,
      args: [crypto.randomUUID(), from_name || fromCityMain, to_name || toCityMain,
             date, result.overall_min_price, Date.now(), card_type],
    });
  } catch (_) {}

  return json({ ...result, cached: false }, 200, origin);
}

// ── /api/alerts ───────────────────────────────────────────────────────────
async function handleAlerts(req, env, origin) {
  if (req.method === "GET") {
    const uid = new URL(req.url).searchParams.get("user_id");
    if (!uid) return json({ error: "user_id requis" }, 400, origin);
    const r = await db(env).execute({
      sql: `SELECT * FROM price_alerts WHERE user_id=? AND active=1 ORDER BY created_at DESC`,
      args: [uid],
    });
    return json({ alerts: r.rows }, 200, origin);
  }
  if (req.method === "POST") {
    const b = await req.json();
    const { user_id, from_station, from_id, to_station, to_id, max_price, email, card_type = "none" } = b;
    if (!user_id || !from_station || !to_station) return json({ error: "Champs manquants" }, 400, origin);
    const id = crypto.randomUUID();
    await db(env).execute({
      sql: `INSERT INTO price_alerts
            (id,user_id,from_station,from_id,to_station,to_id,travel_date,max_price,email,created_at,active,card_type)
            VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`,
      args: [id, user_id, from_station, from_id||"", to_station, to_id||"", "", max_price||null, email||null, Date.now(), card_type],
    });
    return json({ success: true, id }, 201, origin);
  }
  if (req.method === "DELETE") {
    const u = new URL(req.url);
    const id = u.searchParams.get("id"), uid = u.searchParams.get("user_id");
    if (!id || !uid) return json({ error: "id + user_id requis" }, 400, origin);
    await db(env).execute({
      sql: `UPDATE price_alerts SET active=0 WHERE id=? AND user_id=?`,
      args: [id, uid],
    });
    return json({ success: true }, 200, origin);
  }
  return json({ error: "Method not allowed" }, 405, origin);
}

// ── /api/trending ─────────────────────────────────────────────────────────
async function handleTrending(env, origin) {
  const cached = await env.CACHE.get("trending3", "json");
  if (cached) return json(cached, 200, origin);
  try {
    const r = await db(env).execute(`
      SELECT from_station, to_station, COUNT(*) as searches, MIN(min_price) as best_price
      FROM search_log
      WHERE searched_at > ${Date.now() - 7 * 86400000}
      GROUP BY from_station, to_station
      ORDER BY searches DESC LIMIT 10
    `);
    await env.CACHE.put("trending3", JSON.stringify(r.rows), { expirationTtl: 3600 });
    return json(r.rows, 200, origin);
  } catch (_) {
    return json([], 200, origin);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return preflight(origin);

    const path = new URL(request.url).pathname;
    try {
      if (path === "/api/autocomplete"  && request.method === "GET")  return handleAutocomplete(request, env);
      if (path === "/api/search"        && request.method === "POST") return handleSearch(request, env, origin);
      if (path === "/api/alerts")                                      return handleAlerts(request, env, origin);
      if (path === "/api/trending"      && request.method === "GET")  return handleTrending(env, origin);
      if (path === "/api/health")       return json({ ok: true, ts: Date.now() }, 200, origin);
      return json({ error: "Not found" }, 404, origin);
    } catch (err) {
      console.error(err);
      return json({ error: err.message || "Erreur interne" }, 500, origin);
    }
  },
};
