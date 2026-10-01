<p align="center">
  <img src="https://raw.githubusercontent.com/andrewkimjoseph/celina/main/assets/celina-banner.svg" alt="Celina — Give your LLM a wallet on Celo">
</p>

# Celina Stats API

Public Cloudflare Worker for Celina on-chain ingest, Amplitude export cron, npm package stats, and off-chain dashboard reads. Aggregates and the event list are computed here from Supabase `amplitude_events`, which the midnight cron fills from Amplitude. Tagged Celo transactions land via `POST /onchain`. Dashboard reads require a bearer token.

Production host: **https://api.stats.usecelina.xyz**

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, service, checks: { supabase, uptimeStore } }` — 503 if Supabase or the uptime KV binding is unavailable |
| POST | `/onchain` | Ingest `{ "hash": "0x…" }` — verifies the Celo receipt succeeded and calldata carries the `celina` attribution tag, then upserts `celina_txns`. 60 requests / 60s per IP |
| POST | `/telemetry` | Forward one SDK read event to Amplitude. 600 requests / 60s per IP. The write key stays on this Worker |
| GET | `/onchain` | `{ rows, lastSyncedAt }` — stored celina-tagged transactions. Requires `Authorization: Bearer $STATS_READ_KEY` |
| GET | `/offchain/daily` | `{ rows: [{ day, count }], total }` — `rows` last 90 days; `total` all-time. Requires the read key |
| GET | `/offchain/wallets` | `{ daily: [{ day, count }], total }` — distinct valid `0x` `user_id` (90 days) |
| GET | `/offchain/tools` | `{ rows: [{ event, count }] }` — per-tool counts (90 days) |
| GET | `/offchain/projects` | `{ rows: [{ project, count }] }` — snake_case projects (90 days); excludes SDK; MCP installs collapse to `andrewkimjoseph_celina_mcp` |
| GET | `/offchain/devices` | `{ uniqueDevices }` — distinct `device_id` (90 days) |
| GET | `/offchain/sync` | `{ lastSyncedAt }` — Amplitude export cursor |
| GET | `/offchain/events` | `{ rows, lastSyncedAt }` — all calls, newest first (`insert_id`, `event_time`, `event_type`, `device_id`) |
| GET | `/package` | Merged npm downloads for celina-mcp, celina-sdk, and the legacy celina wrapper (live from the npm registry). Requires the read key |
| GET | `/uptime` | `{ days }` — last 30 daily health snapshots for [status.usecelina.xyz](https://status.usecelina.xyz). Public. Each day lists MCP Remote, API, bot, stats API, website, and Celeste |

`GET /onchain`, `GET /offchain/*`, and `GET /package` require `Authorization: Bearer $STATS_READ_KEY`. If that secret is unset, those routes return 401.

`POST /onchain` is unauthenticated. Trust is on-chain: only successful, `celina`-tagged Celo mainnet transactions are stored. A Workers rate limit caps it at 60 requests per minute per client IP.

SDK read telemetry posts to `POST /telemetry`. This Worker adds `AMPLITUDE_API_KEY` and forwards one event to Amplitude. The daily export cron is the only writer of `amplitude_events`. See the [`celina-sdk` telemetry docs](https://github.com/andrewkimjoseph/celina-sdk/blob/main/docs/guides/telemetry.md).

## Local dev

```bash
npm install
cp .env.example .dev.vars
npm test
npm run dev
```

Requires Node.js ≥ 20. Depends on published `@andrewkimjoseph/celina-sdk` (exact version) — no `file:` links.

## Deploy

`npx wrangler deploy`. `account_id` in `wrangler.jsonc` pins the CELINA account. If Wrangler reports an account error, delete `node_modules/.cache/wrangler/wrangler-account.json` and retry.

See **[DEPLOY.md](DEPLOY.md)** for secrets, custom domain `api.stats.usecelina.xyz`, and smoke tests.

A daily cron (`0 0 * * *` UTC) syncs the Amplitude export into Supabase and writes that day's health snapshot to `UPTIME_STORE`. The export is how off-chain usage reaches the dashboard. [celina-status](https://github.com/andrewkimjoseph/celina-status) at [status.usecelina.xyz](https://status.usecelina.xyz) reads `GET /uptime` for the 30-day history. On-chain rows arrive via `POST /onchain`. There is no chain-scan cron.

## License

MIT
