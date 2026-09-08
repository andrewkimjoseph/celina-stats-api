<p align="center">
  <img src="https://raw.githubusercontent.com/andrewkimjoseph/celina/main/assets/celina-banner.svg" alt="Celina — Give your LLM a wallet on Celo">
</p>

# Celina Stats API

Public Cloudflare Worker for Celina on-chain, off-chain, and npm package stats. This is the **single place** dashboards and the SDK write to for tagged Celo transactions and read-tool usage events. The SDK reports usage to `POST /events` (stored in `amplitude_events`); a daily Amplitude export cron is kept for historical continuity.

Production host: **https://api.stats.usecelina.xyz**

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, service: "celina-stats-api" }` |
| POST | `/onchain` | Ingest `{ "hash": "0x…" }` — verifies the Celo receipt succeeded and calldata carries the `celina` attribution tag, then upserts `celina_txns` |
| GET | `/onchain` | `{ rows, lastSyncedAt }` — stored celina-tagged transactions |
| POST | `/events` | Ingest `{ insertId, event, deviceId, userId?, occurredAt }` — celina-sdk usage-event reporting; upserts straight into `amplitude_events` (same row shape/dedupe as the Amplitude export sync) |
| GET | `/offchain` | Daily/tool/wallet aggregates over `amplitude_events` (Amplitude export sync + real-time `POST /events` reports) |
| GET | `/package` | Merged npm downloads for celina-mcp, celina-sdk, and the legacy celina wrapper (live from the npm registry) |

`POST /onchain` and `POST /events` are unauthenticated. Trust for `/onchain` is on-chain: only successful, `celina`-tagged Celo mainnet transactions are stored. `POST /events` is how `@andrewkimjoseph/celina-sdk` reports its own read-telemetry (no third-party Amplitude key bundled in the SDK anymore — see [`celina-sdk` telemetry docs](https://github.com/andrewkimjoseph/celina-sdk/blob/main/docs/guides/telemetry.md)). CORS allows any origin so the SDK can report from browsers and Node.

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

A daily cron (`0 0 * * *` UTC) syncs the Amplitude export into Supabase (kept for historical continuity). On-chain rows arrive in real time via `POST /onchain`, and SDK usage events arrive in real time via `POST /events` — there is no chain-scan cron.

## License

MIT
