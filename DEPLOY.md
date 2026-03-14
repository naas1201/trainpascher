# TrainPascher — Deployment Guide

## Prerequisites
- Node.js 18+
- Wrangler CLI: `npm install -g wrangler`
- Cloudflare account (free tier works)
- Turso account (free tier: 500 DBs, 1B row reads/month)

---

## 1. Turso database

```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash

# Login
turso auth login

# Create database
turso db create trainpascher

# Get URL and token
turso db show trainpascher --url    # e.g. libsql://trainpascher-yourname.turso.io
turso db tokens create trainpascher  # save this token
```

---

## 2. Cloudflare Worker

```bash
cd worker
npm install

# Login to Cloudflare
wrangler login

# Create KV namespace
wrangler kv namespace create CACHE
# → Copy the id into wrangler.toml [[kv_namespaces]] section
wrangler kv namespace create CACHE --preview
# → Copy preview_id into wrangler.toml too

# Set secrets (never commit these)
wrangler secret put SNCF_API_KEY
# → paste: edff6a699f469dc0c521c3f659d1b0324648de08c9da2a19e66aa0ff

wrangler secret put TURSO_URL
# → paste your libsql://... URL

wrangler secret put TURSO_AUTH_TOKEN
# → paste your Turso token

# Initialize Turso schema via worker (run once)
# Or via turso CLI:
turso db shell trainpascher < schema.sql

# Deploy worker
wrangler deploy
# → Note your worker URL: https://trainpascher-worker.<subdomain>.workers.dev
```

---

## 3. Frontend (Cloudflare Pages)

1. Edit `frontend/app.js` line 6 — replace the worker URL with your actual deployed URL.

2. Deploy via Wrangler:
```bash
wrangler pages deploy frontend --project-name trainpascher
```

Or connect your GitHub repo in the Cloudflare Dashboard → Pages → New project.
- Build command: *(none — static site)*
- Build output directory: `frontend`

---

## 4. Local development

```bash
# Terminal 1 — Worker
cd worker
npm run dev
# Worker runs at http://localhost:8787

# Terminal 2 — Frontend
cd frontend
npx serve .    # or just open index.html in browser
# Make sure app.js API points to http://localhost:8787
```

---

## 5. Update CORS in wrangler.toml

Once you know your Pages URL, update:
```toml
[vars]
CORS_ORIGIN = "https://trainpascher.pages.dev"
```
Then redeploy the worker.

---

## Environment variables summary

| Secret / Var | Where | Value |
|---|---|---|
| `SNCF_API_KEY` | Worker secret | Your Navitia key |
| `TURSO_URL` | Worker secret | `libsql://trainpascher-xxx.turso.io` |
| `TURSO_AUTH_TOKEN` | Worker secret | Turso JWT token |
| `CORS_ORIGIN` | wrangler.toml var | Your Pages URL |
| `CACHE` | KV namespace binding | Set in wrangler.toml |
