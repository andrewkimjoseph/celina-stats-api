/**
 * TEMPORARY one-off script — safe to delete (along with the `backfill:gap` npm
 * script and the `tsx` devDependency, if unused elsewhere) once the celina-sdk
 * `POST /events` cutover is live in production and this window is confirmed
 * backfilled in Supabase.
 *
 * Forces an Amplitude export -> Supabase upsert for Sep 7-8, 2026 (the gap
 * between "last automatic cron run" and "SDK cutover to POST /events"),
 * bypassing `syncAmplitudeExport`'s 24h cache gate.
 *
 * Usage: `npm run backfill:gap` (reads `.dev.vars` from the repo root, same
 * format as `wrangler dev` — copy `.env.example` to `.dev.vars` and fill in
 * real SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / AMPLITUDE_API_KEY /
 * AMPLITUDE_SECRET_KEY first).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAmplitudeBackfill } from "../src/amplitude.js";
import type { StatsEnv } from "../src/env.js";

const START_HOUR = "2026090700";
const END_HOUR = "2026090823";

function loadDevVars(): Partial<StatsEnv> {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const path = join(root, ".dev.vars");
  if (!existsSync(path)) {
    throw new Error(
      `Missing ${path} — copy .env.example to .dev.vars and fill in real credentials first.`,
    );
  }
  const env: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env as Partial<StatsEnv>;
}

async function main(): Promise<void> {
  const env = loadDevVars() as StatsEnv;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .dev.vars");
  }
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_SECRET_KEY) {
    throw new Error("Missing AMPLITUDE_API_KEY / AMPLITUDE_SECRET_KEY in .dev.vars");
  }

  console.log(`[backfill-amplitude-gap] pulling Amplitude export ${START_HOUR} -> ${END_HOUR}...`);
  const result = await runAmplitudeBackfill(env, START_HOUR, END_HOUR);
  console.log(
    `[backfill-amplitude-gap] done — pulled ${result.pulled} raw events, upserted ${result.upserted} rows into amplitude_events.`,
  );
}

main().catch((err) => {
  console.error("[backfill-amplitude-gap] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
