/**
 * TrainPascher — SNCF Ticket Hunter
 * Cloudflare Worker using data.sncf.com free Opendatasoft API
 */

import { createClient } from "@libsql/client/web";

const ODS = "https://data.sncf.com/api/explore/v2.1/catalog/datasets";

// ─── CORS ──────────────────────────────────────────────────────────────────

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

function odsHeaders(apiKey) {
  return { Authorization: `Apikey ${apiKey}`, Accept: "application/json" };
}

// ─── City keyword extraction ───────────────────────────────────────────────
// "Paris Gare de Lyon" → "Paris"  (finds ALL Paris stations in tarifs)
// "Bordeaux Saint-Jean" → "Bordeaux"
// "Saint-Étienne" → "Saint Etienne"
function cityKeyword(stationName) {
  const name = stationName.trim();
  const words = name.split(/[\s\-–]+/);
  const first = words[0].toLowerCase();
  if ((first === "saint" || first === "st") && words[1]) {
    return words[0] + " " + words[1];
  }
  return words[0];
}

// ─── data.sncf.com API ─────────────────────────────────────────────────────

async function searchPlaces(query, apiKey) {
  const safe = query.replace(/"/g, "").trim();
  const url =
    `${ODS}/gares-de-voyageurs/records` +
    `?limit=8&select=nom,libellecourt,codes_uic` +
    `&where=search(nom,"${encodeURIComponent(safe)}")`;
  const res = await fetch(url, { headers: odsHeaders(apiKey) });
  if (!res.ok) throw new Error(`Stations API error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).map((g) => ({
    id: g.codes_uic || g.nom,
    name: g.nom,
    label: g.libellecourt ? `${g.nom} (${g.libellecourt})` : g.nom,
  }));
}

// Search fares using city keywords so "Paris" matches ALL Paris stations
async function searchFares(fromName, toName, apiKey) {
  const fromKw = cityKeyword(fromName).replace(/"/g, "");
  const toKw   = cityKeyword(toName).replace(/"/g, "");

  const url =
    `${ODS}/tarifs-tgv-inoui-ouigo/records?limit=100` +
    `&select=transporteur,gare_origine,gare_destination,classe,profil_tarifaire,prix_minimum,prix_maximum` +
    `&where=search(gare_origine,"${encodeURIComponent(fromKw)}")` +
    `%20AND%20search(gare_destination,"${encodeURIComponent(toKw)}")`;

  const res = await fetch(url, { headers: odsHeaders(apiKey) });
  if (!res.ok) throw new Error(`Fares API error: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// Check if a city has any TGV/OUIGO station (for TER fallback messaging)
async function cityHasTgvStation(stationName, apiKey) {
  const kw = cityKeyword(stationName).replace(/"/g, "");
  const url =
    `${ODS}/tarifs-tgv-inoui-ouigo/records?limit=1` +
    `&select=gare_origine` +
    `&where=search(gare_origine,"${encodeURIComponent(kw)}")` +
    `%20OR%20search(gare_destination,"${encodeURIComponent(kw)}")`;
  const res = await fetch(url, { headers: odsHeaders(apiKey) });
  if (!res.ok) return false;
  const data = await res.json();
  return (data.total_count || 0) > 0;
}

// ─── Fare parsing ──────────────────────────────────────────────────────────

const PROFILE_ORDER = [
  "Tarif Normal",
  "Tarif Avantage",
  "Tarif Réglementé",
  "Tarif Élève - Étudiant - Apprenti",
  "Tarif Elève - Etudiant - Apprenti",
];

function parseFares(records) {
  // Group by carrier + class + route (origin→destination)
  const grouped = {};

  for (const r of records) {
    const key = `${r.transporteur}|${r.classe}|${r.gare_origine}|${r.gare_destination}`;
    if (!grouped[key]) {
      grouped[key] = {
        carrier: r.transporteur,
        from: r.gare_origine,
        to: r.gare_destination,
        class: r.classe === "1" ? "1ère classe" : "2ème classe",
        class_raw: r.classe,
        min_price: r.prix_minimum,
        max_price: r.prix_maximum,
        profiles: [],
      };
    } else {
      grouped[key].min_price = Math.min(grouped[key].min_price, r.prix_minimum);
      grouped[key].max_price = Math.max(grouped[key].max_price, r.prix_maximum);
    }
    grouped[key].profiles.push({
      name: r.profil_tarifaire,
      min: r.prix_minimum,
      max: r.prix_maximum,
    });
  }

  return Object.values(grouped)
    .map((g) => {
      // Sort profiles: Normal first, then others
      g.profiles.sort((a, b) => {
        const ai = PROFILE_ORDER.indexOf(a.name);
        const bi = PROFILE_ORDER.indexOf(b.name);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });
      return g;
    })
    // Sort: cheapest first, then by carrier (OUIGO before TGV)
    .sort((a, b) => {
      if (a.min_price !== b.min_price) return a.min_price - b.min_price;
      if (a.carrier.includes("OUIGO") && !b.carrier.includes("OUIGO")) return -1;
      return 0;
    });
}

// ─── Booking URLs ──────────────────────────────────────────────────────────

function sncfConnectUrl(fromName, toName, date) {
  const f = encodeURIComponent(fromName);
  const t = encodeURIComponent(toName);
  const d = date ? date.replace(/-/g, "") : "";
  return `https://www.sncf-connect.com/app/home/search?originLabel=${f}&destinationLabel=${t}${d ? `&outwardDate=${d}` : ""}&passengers=1`;
}

function ouigoUrl() {
  return "https://www.ouigo.com";
}

// ─── Turso ────────────────────────────────────────────────────────────────

function getDb(env) {
  return createClient({ url: env.TURSO_URL, authToken: env.TURSO_AUTH_TOKEN });
}

// ─── Route handlers ───────────────────────────────────────────────────────

async function handleAutocomplete(req, env) {
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json([]);

  const cacheKey = `ac2:${q.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json(cached);

  const places = await searchPlaces(q, env.SNCF_API_KEY);
  await env.CACHE.put(cacheKey, JSON.stringify(places), { expirationTtl: 86400 });
  return json(places);
}

async function handleSearch(req, env, origin) {
  const body = await req.json();
  const { from_name, to_name, date } = body;

  if (!from_name || !to_name) {
    return json({ error: "Missing from_name or to_name" }, 400, origin);
  }

  const fromKw = cityKeyword(from_name);
  const toKw   = cityKeyword(to_name);
  const cacheKey = `fares2:${fromKw.toLowerCase()}:${toKw.toLowerCase()}`;

  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) {
    return json({
      ...cached,
      cached: true,
      booking_url: sncfConnectUrl(from_name, to_name, date),
    }, 200, origin);
  }

  const raw = await searchFares(from_name, to_name, env.SNCF_API_KEY);
  const fares = parseFares(raw);

  let result;

  if (fares.length > 0) {
    result = { type: "tgv_ouigo", fares };

    // Log to Turso
    try {
      const db = getDb(env);
      await db.execute({
        sql: `INSERT OR IGNORE INTO search_log (id, from_station, to_station, travel_date, min_price, searched_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: [crypto.randomUUID(), from_name, to_name, date || "", fares[0]?.min_price ?? null, Date.now()],
      });
    } catch (_) {}
  } else {
    // No TGV/OUIGO — check if each city has any TGV station
    const [fromTgv, toTgv] = await Promise.all([
      cityHasTgvStation(from_name, env.SNCF_API_KEY),
      cityHasTgvStation(to_name, env.SNCF_API_KEY),
    ]);
    result = { type: "ter_route", fares: [], from_has_tgv: fromTgv, to_has_tgv: toTgv };
  }

  await env.CACHE.put(cacheKey, JSON.stringify(result), { expirationTtl: 3600 });

  return json({
    ...result,
    cached: false,
    booking_url: sncfConnectUrl(from_name, to_name, date),
    ouigo_url: ouigoUrl(),
  }, 200, origin);
}

async function handleAlerts(req, env, origin) {
  if (req.method === "GET") {
    const url = new URL(req.url);
    const userId = url.searchParams.get("user_id");
    if (!userId) return json({ error: "Missing user_id" }, 400, origin);
    const db = getDb(env);
    const result = await db.execute({
      sql: `SELECT * FROM price_alerts WHERE user_id = ? AND active = 1 ORDER BY created_at DESC`,
      args: [userId],
    });
    return json({ alerts: result.rows }, 200, origin);
  }

  if (req.method === "POST") {
    const body = await req.json();
    const { user_id, from_station, from_id, to_station, to_id, max_price, email } = body;
    if (!user_id || !from_station || !to_station) {
      return json({ error: "Missing required fields" }, 400, origin);
    }
    const db = getDb(env);
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO price_alerts (id, user_id, from_station, from_id, to_station, to_id, travel_date, max_price, email, created_at, active)
            VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, 1)`,
      args: [id, user_id, from_station, from_id || "", to_station, to_id || "", max_price || null, email || null, Date.now()],
    });
    return json({ success: true, id }, 201, origin);
  }

  if (req.method === "DELETE") {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const userId = url.searchParams.get("user_id");
    if (!id || !userId) return json({ error: "Missing id or user_id" }, 400, origin);
    const db = getDb(env);
    await db.execute({
      sql: `UPDATE price_alerts SET active = 0 WHERE id = ? AND user_id = ?`,
      args: [id, userId],
    });
    return json({ success: true }, 200, origin);
  }

  return json({ error: "Method not allowed" }, 405, origin);
}

async function handleTrending(env, origin) {
  const cacheKey = "trending2";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json(cached, 200, origin);

  try {
    const db = getDb(env);
    const result = await db.execute(`
      SELECT from_station, to_station, COUNT(*) as searches, MIN(min_price) as best_price
      FROM search_log
      WHERE searched_at > ${Date.now() - 7 * 24 * 60 * 60 * 1000}
      GROUP BY from_station, to_station
      ORDER BY searches DESC
      LIMIT 10
    `);
    const trending = result.rows;
    await env.CACHE.put(cacheKey, JSON.stringify(trending), { expirationTtl: 3600 });
    return json(trending, 200, origin);
  } catch (_) {
    return json([], 200, origin);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const path = new URL(request.url).pathname;

    try {
      if (path === "/api/autocomplete" && request.method === "GET")
        return await handleAutocomplete(request, env);
      if (path === "/api/search" && request.method === "POST")
        return await handleSearch(request, env, origin);
      if (path === "/api/alerts")
        return await handleAlerts(request, env, origin);
      if (path === "/api/trending" && request.method === "GET")
        return await handleTrending(env, origin);
      if (path === "/api/health")
        return json({ status: "ok", ts: Date.now() }, 200, origin);

      return json({ error: "Not found" }, 404, origin);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: err.message || "Internal error" }, 500, origin);
    }
  },
};
