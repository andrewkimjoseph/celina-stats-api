# Deploy — Celina Stats API (Cloudflare Workers)

Deploy with the Wrangler CLI. [`wrangler.jsonc`](wrangler.jsonc) pins `account_id` to the CELINA Cloudflare account.

```bash
npx wrangler deploy
```

If Wrangler reports an authentication or account error, delete `node_modules/.cache/wrangler/wrangler-account.json` in this repo and retry. That file can keep a previous login's account after you switch accounts.

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

Set with Wrangler (`npx wrangler secret put NAME`), reading the value from `.dev.vars`. Do not commit that file.

| Variable | Required | Notes |
|----------|----------|-------|
| `SUPABASE_URL` | Yes | Stats Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Service role — never expose to browsers |
| `CELO_RPC_URL` | Optional | Celo mainnet RPC (default: Forno) |
| `AMPLITUDE_API_KEY` | Yes | Amplitude project write key. `POST /telemetry` forwards with it, and the export cron reads with it |
| `AMPLITUDE_SECRET_KEY` | Yes for Amplitude export cron | Amplitude secret. Not used by `POST /telemetry` |
| `AMPLITUDE_REGION` | Optional | `us` (default) or `eu` |
| `STATS_READ_KEY` | Yes | Bearer token for dashboard reads. Set the same value on celina-website |

The midnight cron is the only writer of `amplitude_events`. `POST /telemetry` forwards one SDK read event to Amplitude and is rate-limited (600 requests / 60s per IP) by `TELEMETRY_RATE_LIMITER`. `POST /onchain` stays open and is rate-limited (60 requests / 60s per IP) by `ONCHAIN_RATE_LIMITER`. Both bindings are in `wrangler.jsonc`.

Wrangler loads `.dev.vars` automatically for `npm run dev`.

## Custom domain

Suggested production host: **https://api.stats.usecelina.xyz**

Attach `api.stats.usecelina.xyz` as a custom domain on the Worker (dashboard: Settings → Domains & Routes), or add a `routes` entry with `"custom_domain": true` in [`wrangler.jsonc`](wrangler.jsonc) and deploy.

## Cron

[`wrangler.jsonc`](wrangler.jsonc) defines `0 0 * * *` (midnight UTC). `npx wrangler deploy` publishes that cron trigger with the Worker. The scheduled handler syncs the Amplitude export and writes that day's health snapshot. The stats service is recorded in-process — the cron does not `fetch` its own public URL.

After deploy:

1. `npx wrangler deployments list` (or the dashboard Triggers page) should show the cron `0 0 * * *`. Do not add a second copy if it is already there.
2. Secrets must include `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AMPLITUDE_API_KEY`, and `AMPLITUDE_SECRET_KEY`. Without the Amplitude pair the handler logs `skipped` and writes nothing.
4. After midnight UTC, **Observability → Logs** shows the sync result (`synced`, `partial`, or `empty_window`). `lastSyncedAt` from `GET /offchain/sync` means the cursor moved. It does not mean every event through midnight was stored. The sync stops at the latest hour Amplitude has closed (about two hours after that hour ends) and does not advance past an hour that is not ready yet.

Run the same sync locally (reads `.dev.vars`, does not deploy):

```bash
npm run sync:amplitude
npm run sync:amplitude -- 20260922T12 20260923T03
```

The second form forces an hour window (`YYYYMMDDTHH`). The end hour is capped at the latest closed hour.

## Smoke test

Replace the host with your `workers.dev` URL or custom domain:

```bash
curl -sS https://api.stats.usecelina.xyz/health

curl -sS https://api.stats.usecelina.xyz/onchain \
  -H "Authorization: Bearer $STATS_READ_KEY" | head -c 200

curl -sS https://api.stats.usecelina.xyz/package \
  -H "Authorization: Bearer $STATS_READ_KEY" | head -c 200

curl -sS https://api.stats.usecelina.xyz/offchain/daily \
  -H "Authorization: Bearer $STATS_READ_KEY" | head -c 200

curl -sS https://api.stats.usecelina.xyz/offchain/events \
  -H "Authorization: Bearer $STATS_READ_KEY" | head -c 200

curl -sS https://api.stats.usecelina.xyz/onchain \
  -H 'Content-Type: application/json' \
  -d '{"hash":"0xYOUR_SUCCESSFUL_CELINA_TX"}'
```

Expected: `{ "ok": true, "service": "celina-stats-api", "checks": { "supabase": true, "uptimeStore": true } }` (HTTP 503 when Supabase or `UPTIME_STORE` is unavailable), a JSON object with `rows` from `/onchain`, merged npm `rows` from `/package`, `{ rows, total }` from `/offchain/daily`, `{ rows, lastSyncedAt }` from `/offchain/events`, and `{ "ok": true, "hash": "0x…" }` for a real tagged successful tx. Reads without the bearer token return 401. Deploy this Worker before celina-website, and set `STATS_READ_KEY` on both, or `/stats` returns 401 until the website sends the header.
