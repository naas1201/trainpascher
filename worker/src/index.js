/**
 * TrainPascher — SNCF Ticket Hunter
 * Cloudflare Worker: API proxy, caching via KV, alerts via Turso
 */

import { createClient } from "@libsql/client/web";

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
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
    },
  });
}

// ─── SNCF Navitia helpers ──────────────────────────────────────────────────

function navitiaHeaders(apiKey) {
  return {
    Authorization: `Basic ${btoa(apiKey + ":")}`,
    Accept: "application/json",
  };
}

const NAVITIA = "https://api.sncf.com/v1/coverage/sncf";

async function searchPlaces(query, apiKey) {
  const url = `${NAVITIA}/places?q=${encodeURIComponent(query)}&type[]=stop_area&count=8`;
  const res = await fetch(url, { headers: navitiaHeaders(apiKey) });
  if (!res.ok) throw new Error(`Navitia places error: ${res.status}`);
  const data = await res.json();
  return (data.places || [])
    .filter((p) => p.embedded_type === "stop_area")
    .map((p) => ({
      id: p.stop_area.id,
      name: p.stop_area.name,
      label: p.name,
    }));
}

async function searchJourneys(fromId, toId, datetime, apiKey) {
  const url =
    `${NAVITIA}/journeys` +
    `?from=${encodeURIComponent(fromId)}` +
    `&to=${encodeURIComponent(toId)}` +
    `&datetime=${encodeURIComponent(datetime)}` +
    `&count=8` +
    `&data_freshness=realtime`;

  const res = await fetch(url, { headers: navitiaHeaders(apiKey) });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Navitia journeys error ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return parseJourneys(data);
}

function parseJourneys(data) {
  const journeys = data.journeys || [];
  return journeys
    .filter((j) => j.status !== "no_solution")
    .map((j) => {
      // Extract fare information
      const fare = j.fare || {};
      const found = fare.found === true;
      const totalPrice = fare.total
        ? parseFloat(fare.total.value) / 100
        : null;
      const currency = fare.total?.currency || "EUR";

      // Extract sections (train legs)
      const sections = (j.sections || [])
        .filter((s) => s.type === "public_transport")
        .map((s) => ({
          from: s.from?.name || "",
          to: s.to?.name || "",
          departure: s.departure_date_time,
          arrival: s.arrival_date_time,
          line: s.display_informations?.label || "",
          direction: s.display_informations?.direction || "",
          network: s.display_informations?.network || "",
          physical_mode: s.display_informations?.physical_mode || "",
          headsign: s.display_informations?.headsign || "",
        }));

      const departureTime = j.departure_date_time;
      const arrivalTime = j.arrival_date_time;
      const durationMin = Math.round(j.duration / 60);
      const transfers = j.nb_transfers || 0;

      return {
        id: j.id || crypto.randomUUID(),
        departure: departureTime,
        arrival: arrivalTime,
        duration_min: durationMin,
        transfers,
        fare_found: found,
        price: totalPrice,
        currency,
        sections,
        status: j.status || "ok",
      };
    })
    .sort((a, b) => {
      // Sort by price (nulls last), then by departure
      if (a.price !== null && b.price !== null) return a.price - b.price;
      if (a.price !== null) return -1;
      if (b.price !== null) return 1;
      return a.departure.localeCompare(b.departure);
    });
}

// ─── Turso helpers ──────────────────────────────────────────────────────────

function getDb(env) {
  return createClient({
    url: env.TURSO_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });
}

// ─── Route handlers ─────────────────────────────────────────────────────────

async function handleAutocomplete(req, env) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") || "";
  if (q.length < 2) return json([]);

  // Cache autocomplete in KV for 1 hour
  const cacheKey = `autocomplete:${q.toLowerCase()}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json(cached);

  const places = await searchPlaces(q, env.SNCF_API_KEY);
  await env.CACHE.put(cacheKey, JSON.stringify(places), {
    expirationTtl: 3600,
  });
  return json(places);
}

async function handleSearch(req, env, origin) {
  const body = await req.json();
  const { from_id, to_id, from_name, to_name, date } = body;

  if (!from_id || !to_id || !date) {
    return json({ error: "Missing from_id, to_id, or date" }, 400, origin);
  }

  // Normalize datetime: if only date given, use 06:00
  const datetime = date.includes("T") ? date : `${date}T060000`;

  // Cache search results in KV for 15 min
  const cacheKey = `journeys:${from_id}:${to_id}:${datetime}`;
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) {
    return json({ journeys: cached, cached: true }, 200, origin);
  }

  const journeys = await searchJourneys(from_id, to_id, datetime, env.SNCF_API_KEY);

  await env.CACHE.put(cacheKey, JSON.stringify(journeys), {
    expirationTtl: 900, // 15 min
  });

  // Log search to Turso (non-blocking)
  const minPrice = journeys.find((j) => j.price !== null)?.price ?? null;
  try {
    const db = getDb(env);
    await db.execute({
      sql: `INSERT OR IGNORE INTO search_log (id, from_station, to_station, travel_date, min_price, searched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        from_name || from_id,
        to_name || to_id,
        date,
        minPrice,
        Date.now(),
      ],
    });
  } catch (_) {
    // Don't fail the request if Turso is down
  }

  return json({ journeys, cached: false }, 200, origin);
}

async function handleAlerts(req, env, origin) {
  const method = req.method;

  if (method === "GET") {
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

  if (method === "POST") {
    const body = await req.json();
    const { user_id, from_station, from_id, to_station, to_id, travel_date, max_price, email } = body;

    if (!user_id || !from_id || !to_id || !travel_date) {
      return json({ error: "Missing required fields" }, 400, origin);
    }

    const db = getDb(env);
    const id = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO price_alerts (id, user_id, from_station, from_id, to_station, to_id, travel_date, max_price, email, created_at, active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      args: [id, user_id, from_station, from_id, to_station, to_id, travel_date, max_price || null, email || null, Date.now()],
    });
    return json({ success: true, id }, 201, origin);
  }

  if (method === "DELETE") {
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
  const cacheKey = "trending:routes";
  const cached = await env.CACHE.get(cacheKey, "json");
  if (cached) return json(cached, 200, origin);

  try {
    const db = getDb(env);
    const result = await db.execute(`
      SELECT from_station, to_station, COUNT(*) as searches, AVG(min_price) as avg_price
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

// ─── Main fetch handler ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/api/autocomplete" && request.method === "GET") {
        return await handleAutocomplete(request, env);
      }
      if (path === "/api/search" && request.method === "POST") {
        return await handleSearch(request, env, origin);
      }
      if (path === "/api/alerts") {
        return await handleAlerts(request, env, origin);
      }
      if (path === "/api/trending" && request.method === "GET") {
        return await handleTrending(env, origin);
      }
      if (path === "/api/health") {
        return json({ status: "ok", ts: Date.now() }, 200, origin);
      }

      return json({ error: "Not found" }, 404, origin);
    } catch (err) {
      console.error("Worker error:", err);
      return json({ error: err.message || "Internal error" }, 500, origin);
    }
  },
};
