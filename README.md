<p align="center">
  <img src="https://raw.githubusercontent.com/andrewkimjoseph/celina/main/assets/celina-banner.svg" alt="Celina — Give your LLM a wallet on Celo">
</p>

# Celina Stats API

Public Cloudflare Worker for Celina on-chain and off-chain stats. This is the **single place** dashboards and the SDK write to for tagged Celo transactions and Amplitude MCP-tool usage.

Production host: **https://api.stats.usecelina.xyz**

## Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | `{ ok, service: "celina-stats-api" }` |
| POST | `/onchain` | Ingest `{ "hash": "0x…" }` — verifies the Celo receipt succeeded and calldata carries the `celina` attribution tag, then upserts `celina_txns` |
| GET | `/onchain` | `{ rows, lastSyncedAt }` — stored celina-tagged transactions |
| GET | `/offchain` | Amplitude daily/tool/wallet aggregates |

`POST /onchain` is unauthenticated. Trust is on-chain: only successful, `celina`-tagged Celo mainnet transactions are stored. CORS allows any origin so the SDK can report from browsers and Node.

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

A daily cron (`0 0 * * *` UTC) syncs the Amplitude export into Supabase. On-chain rows arrive in real time via `POST /onchain` — there is no chain-scan cron.

## License

MIT
