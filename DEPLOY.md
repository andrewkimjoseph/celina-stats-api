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
| `STATS_READ_KEY` | Yes | Bearer token for dashboard reads. Set the same value on celina-website |

The midnight cron is the only writer of `amplitude_events`. SDK read telemetry goes to Amplitude. `POST /onchain` stays open and is rate-limited (60 requests / 60s per IP) by the `ONCHAIN_RATE_LIMITER` binding in `wrangler.jsonc`.

Wrangler loads `.dev.vars` automatically for `npm run dev`.

## Custom domain

Suggested production host: **https://api.stats.usecelina.xyz**

1. Open the Worker in the Cloudflare dashboard
2. **Settings → Domains & Routes → Add Custom Domain**
3. Enter `api.stats.usecelina.xyz`

## Cron

[`wrangler.jsonc`](wrangler.jsonc) defines `0 0 * * *` (midnight UTC). The scheduled handler runs the Amplitude export sync only. Git push is enough when the Worker build runs `wrangler deploy`: that deploys the cron trigger with the Worker.

After the next production deploy of `main`:

1. Dashboard → Workers & Pages → **celina-stats-api** → **Settings → Triggers**.
2. Confirm a Cron Trigger of `0 0 * * *`. If it is missing, add that expression (UTC). Do not add a second copy if it is already there.
3. **Settings → Variables and Secrets** must include `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `AMPLITUDE_API_KEY`, and `AMPLITUDE_SECRET_KEY`. Without the Amplitude pair the handler logs `skipped` and writes nothing.
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

Expected: `{ "ok": true, "service": "celina-stats-api" }`, a JSON object with `rows` from `/onchain`, merged npm `rows` from `/package`, `{ rows, total }` from `/offchain/daily`, `{ rows, lastSyncedAt }` from `/offchain/events`, and `{ "ok": true, "hash": "0x…" }` for a real tagged successful tx. Reads without the bearer token return 401. Deploy this Worker before celina-website, and set `STATS_READ_KEY` on both, or `/stats` returns 401 until the website sends the header.
