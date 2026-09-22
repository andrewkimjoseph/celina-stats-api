<p align="center">
  <img src="https://raw.githubusercontent.com/andrewkimjoseph/celina/main/assets/celina-banner.svg" alt="Celina — Give your LLM a wallet on Celo">
</p>

# Celina Stats API

Public Cloudflare Worker for Celina on-chain ingest, Amplitude export cron, npm package stats, and off-chain dashboard reads. Aggregates and the event list are computed here from Supabase `amplitude_events`, which the midnight cron fills from Amplitude. Tagged Celo transactions land via `POST /onchain`. Dashboard reads require a bearer token.

Production host: **https://api.stats.usecelina.xyz**

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, service: "celina-stats-api" }` |
| POST | `/onchain` | Ingest `{ "hash": "0x…" }` — verifies the Celo receipt succeeded and calldata carries the `celina` attribution tag, then upserts `celina_txns`. 60 requests / 60s per IP |
| GET | `/onchain` | `{ rows, lastSyncedAt }` — stored celina-tagged transactions. Requires `Authorization: Bearer $STATS_READ_KEY` |
| GET | `/offchain/daily` | `{ rows: [{ day, count }], total }` — `rows` last 90 days; `total` all-time. Requires the read key |
| GET | `/offchain/wallets` | `{ daily: [{ day, count }], total }` — distinct valid `0x` `user_id` (90 days) |
| GET | `/offchain/tools` | `{ rows: [{ event, count }] }` — per-tool counts (90 days) |
| GET | `/offchain/projects` | `{ rows: [{ project, count }] }` — snake_case projects (90 days); excludes SDK; MCP installs collapse to `andrewkimjoseph_celina_mcp` |
| GET | `/offchain/devices` | `{ uniqueDevices }` — distinct `device_id` (90 days) |
| GET | `/offchain/sync` | `{ lastSyncedAt }` — Amplitude export cursor |
| GET | `/offchain/events` | `{ rows, lastSyncedAt }` — all calls, newest first (`insert_id`, `event_time`, `event_type`, `device_id`) |
| GET | `/package` | Merged npm downloads for celina-mcp, celina-sdk, and the legacy celina wrapper (live from the npm registry). Requires the read key |

`GET /onchain`, `GET /offchain/*`, and `GET /package` require `Authorization: Bearer $STATS_READ_KEY`. If that secret is unset, those routes return 401.

`POST /onchain` is unauthenticated. Trust is on-chain: only successful, `celina`-tagged Celo mainnet transactions are stored. A Workers rate limit caps it at 60 requests per minute per client IP.

SDK read telemetry goes to Amplitude, not this Worker. The daily export cron is the only writer of `amplitude_events`. See the [`celina-sdk` telemetry docs](https://github.com/andrewkimjoseph/celina-sdk/blob/main/docs/guides/telemetry.md).

## Local dev

```bash
npm install
cp .env.example .dev.vars
npm test
npm run dev
```

Requires Node.js ≥ 20. Depends on published `@andrewkimjoseph/celina-sdk` (exact version) — no `file:` links.

## Deploy

Create the Worker from the **Cloudflare dashboard** (Git integration). Do not use the local Wrangler CLI against this repo if it is logged into a different Cloudflare account.

See **[DEPLOY.md](DEPLOY.md)** for secrets, custom domain `api.stats.usecelina.xyz`, and smoke tests.

A daily cron (`0 0 * * *` UTC) syncs the Amplitude export into Supabase. That is how off-chain usage reaches the dashboard. On-chain rows arrive via `POST /onchain`. There is no chain-scan cron.

## License

MIT
