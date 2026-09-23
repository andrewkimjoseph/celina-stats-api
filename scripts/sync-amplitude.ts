/**
 * Run the Amplitude export sync locally against `.dev.vars`.
 *
 * Default: same window as the midnight cron (`syncAmplitudeExport`).
 * Optional: `npm run sync:amplitude -- YYYYMMDDTHH YYYYMMDDTHH` forces that
 * hour window. The end hour is capped at the latest hour Amplitude has closed.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAmplitudeBackfill, syncAmplitudeExport } from "../src/amplitude.js";
import type { StatsEnv } from "../src/env.js";

function normalizeHour(value: string): string | null {
  const withT = value.match(/^(\d{8})T(\d{2})$/);
  const compact = value.match(/^(\d{8})(\d{2})$/);
  const match = withT ?? compact;
  if (!match) return null;
  const hour = Number(match[2]);
  if (hour > 23) return null;
  return `${match[1]}T${match[2]}`;
}

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

  const [startArg, endArg] = process.argv.slice(2);
  if (startArg !== undefined || endArg !== undefined) {
    const start = startArg ? normalizeHour(startArg) : null;
    const end = endArg ? normalizeHour(endArg) : null;
    if (!start || !end || end < start) {
      throw new Error("Usage: npm run sync:amplitude -- YYYYMMDDTHH YYYYMMDDTHH");
    }
    const result = await runAmplitudeBackfill(env, start, end);
    console.log("[sync-amplitude]", JSON.stringify(result));
    return;
  }

  const result = await syncAmplitudeExport(env);
  console.log("[sync-amplitude]", JSON.stringify(result));
}

main().catch((err) => {
  console.error("[sync-amplitude] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
