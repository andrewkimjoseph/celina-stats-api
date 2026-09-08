# Deploy — Celina Stats API (Cloudflare Workers)

Create and deploy this Worker from the **Cloudflare dashboard** (Workers & Pages → Create → Connect git). Do **not** run `wrangler deploy` / `wrangler login` from a machine whose Wrangler CLI is tied to a different Cloudflare account.

## Prerequisites

- [Cloudflare](https://dash.cloudflare.com) account that should own `celina-stats-api`
- Node.js ≥ 20 (local tests / `wrangler dev` only)
- Repo: [andrewkimjoseph/celina-stats-api](https://github.com/andrewkimjoseph/celina-stats-api)

```bash
cd celina-stats-api
npm install
cp .env.example .dev.vars   # local only
npm test
npm run dev                 # optional — http://localhost:8787
```

## Environment variables

Set in the Cloudflare dashboard (**Workers & Pages → celina-stats-api → Settings → Variables and Secrets**).

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_URL` | Yes | Stats Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role — never expose to browsers |
| `CELO_RPC_URL` | Optional | Celo mainnet RPC (default: Forno) |
| `AMPLITUDE_API_KEY` | Yes for Amplitude export cron | Amplitude project key |
| `AMPLITUDE_SECRET_KEY` | Yes for Amplitude export cron | Amplitude secret |
| `AMPLITUDE_REGION` | Optional | `us` (default) or `eu` |

`POST /events` needs no new secrets — it reuses `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` and writes straight into `amplitude_events`.

Wrangler loads `.dev.vars` automatically for `npm run dev`.

## Custom domain

Suggested production host: **https://api.stats.usecelina.xyz**

1. Open the Worker in the Cloudflare dashboard
2. **Settings → Domains & Routes → Add Custom Domain**
3. Enter `api.stats.usecelina.xyz`

## Cron

[`wrangler.jsonc`](wrangler.jsonc) defines `0 0 * * *` (midnight UTC). The scheduled handler runs the Amplitude export sync only. Confirm the trigger is enabled after connecting the git repo in the dashboard.

## Smoke test

Replace the host with your `workers.dev` URL or custom domain:

```bash
curl -sS https://api.stats.usecelina.xyz/health

curl -sS https://api.stats.usecelina.xyz/onchain | head -c 200

curl -sS https://api.stats.usecelina.xyz/package | head -c 200

curl -sS https://api.stats.usecelina.xyz/onchain \
  -H 'Content-Type: application/json' \
  -d '{"hash":"0xYOUR_SUCCESSFUL_CELINA_TX"}'

curl -sS https://api.stats.usecelina.xyz/events \
  -H 'Content-Type: application/json' \
  -d '{"insertId":"smoke-test-1","event":"get_wallet_address","deviceId":"celina_sdk","occurredAt":"2026-09-08T00:00:00.000Z"}'
```

Expected: `{ "ok": true, "service": "celina-stats-api" }`, a JSON object with `rows` from `/onchain`, merged npm `rows` from `/package`, `{ "ok": true, "hash": "0x…" }` for a real tagged successful tx, and `{ "ok": true }` for `/events`.
