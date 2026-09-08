import { gunzipSync, strFromU8, unzipSync } from "fflate";
import type { StatsEnv } from "./env.js";
import { sbFetch, sbRpcScalar } from "./supabase.js";

export type AmplitudeEventDay = {
  day: string;
  count: number;
};

export type AmplitudeEventTotal = {
  event: string;
  count: number;
};

export type AmplitudeStatsResult = {
  daily: AmplitudeEventDay[];
  dailyWalletsQueried: AmplitudeEventDay[];
  perTool: AmplitudeEventTotal[];
  total: number;
  uniqueDevices: number;
  walletsQueried: number;
  lastSyncedAt: string | null;
};

const LOOKBACK_DAYS = 90;
const CACHE_GATE_MS = 24 * 60 * 60 * 1000;
const EXPORT_CHUNK_HOURS = 6;
const EXPORT_MAX_RETRIES = 2;
const SYNC_FLOOR_ISO = "2026-06-01T00:00:00Z";
const MAX_UNZIPPED_BYTES = 50 * 1024 * 1024;

function ymdh(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  return `${y}${m}${day}T${h}`;
}

function parseYmdh(hour: string): Date {
  const [datePart, hourPart] = hour.split("T");
  return new Date(
    `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${hourPart}:00:00.000Z`,
  );
}

function* exportHourChunks(
  startHour: string,
  endHour: string,
  chunkHours = EXPORT_CHUNK_HOURS,
): Generator<[string, string]> {
  let cur = parseYmdh(startHour);
  const end = parseYmdh(endHour);
  while (cur <= end) {
    const chunkEnd = new Date(cur.getTime() + (chunkHours - 1) * 60 * 60 * 1000);
    const actualEnd = chunkEnd > end ? end : chunkEnd;
    yield [ymdh(cur), ymdh(actualEnd)];
    cur = new Date(actualEnd.getTime() + 60 * 60 * 1000);
  }
}

function isRetryableExportStatus(status: number): boolean {
  return status === 524 || status === 502 || status === 503 || status === 429;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function amplitudeBaseUrl(env: StatsEnv): string {
  const region = (env.AMPLITUDE_REGION ?? "us").toLowerCase();
  return region === "eu"
    ? "https://analytics.eu.amplitude.com"
    : "https://amplitude.com";
}

function authHeader(env: StatsEnv): string {
  const key = env.AMPLITUDE_API_KEY!;
  const secret = env.AMPLITUDE_SECRET_KEY!;
  const token = btoa(`${key}:${secret}`);
  return `Basic ${token}`;
}

async function getSyncState(env: StatsEnv): Promise<{ last_synced_at: string }> {
  const res = await sbFetch(
    env,
    "/rest/v1/amplitude_sync_state?select=last_synced_at&id=eq.1",
  );
  if (!res.ok) {
    throw new Error(
      `Supabase get sync_state ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const rows = (await res.json()) as Array<{ last_synced_at: string }>;
  if (rows.length === 0) {
    const seed = await sbFetch(env, "/rest/v1/amplitude_sync_state", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ id: 1, last_synced_at: SYNC_FLOOR_ISO }),
    });
    if (!seed.ok) {
      throw new Error(
        `Supabase seed sync_state ${seed.status}: ${(await seed.text()).slice(0, 200)}`,
      );
    }
    return { last_synced_at: SYNC_FLOOR_ISO };
  }
  return rows[0];
}

async function setSyncState(env: StatsEnv, iso: string): Promise<void> {
  const res = await sbFetch(env, "/rest/v1/amplitude_sync_state?id=eq.1", {
    method: "PATCH",
    body: JSON.stringify({ last_synced_at: iso, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    throw new Error(
      `Supabase update sync_state ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
}

type RawEvent = { event_type?: string; event_time?: string };
type RawEventFull = RawEvent & {
  $insert_id?: string;
  insert_id?: string;
  user_id?: string | null;
  device_id?: string | null;
  session_id?: number | null;
  amplitude_id?: number | null;
  app?: string | null;
  platform?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  os_name?: string | null;
  device_family?: string | null;
  library?: string | null;
  event_properties?: Record<string, unknown> | null;
  user_properties?: Record<string, unknown> | null;
};

async function pullExportOnce(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<RawEventFull[]> {
  const url = new URL(`${amplitudeBaseUrl(env)}/api/2/export`);
  url.searchParams.set("start", startHour);
  url.searchParams.set("end", endHour);

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(env) },
  });
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(
      `Amplitude export ${res.status}: ${res.statusText} ${body.slice(0, 200)}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const entries = unzipSync(buf);
  const events: RawEventFull[] = [];
  let totalBytes = 0;
  for (const [name, gzipped] of Object.entries(entries)) {
    if (!name.endsWith(".gz") && !name.endsWith(".json.gz")) continue;
    const ndjsonBytes = gunzipSync(gzipped);
    totalBytes += ndjsonBytes.length;
    if (totalBytes > MAX_UNZIPPED_BYTES) {
      throw new Error(
        `Amplitude export payload exceeds ${MAX_UNZIPPED_BYTES} bytes (got ${totalBytes}); aborting`,
      );
    }
    const text = strFromU8(ndjsonBytes);
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed) as RawEventFull);
      } catch {
        // skip malformed line
      }
    }
  }
  return events;
}

async function pullExport(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<RawEventFull[]> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= EXPORT_MAX_RETRIES; attempt++) {
    try {
      return await pullExportOnce(env, startHour, endHour);
    } catch (e) {
      lastError = e instanceof Error ? e : new Error("Amplitude export failed");
      const status = (lastError as Error & { status?: number }).status;
      if (
        attempt === EXPORT_MAX_RETRIES ||
        status === undefined ||
        !isRetryableExportStatus(status)
      ) {
        throw lastError;
      }
      await sleep(1000 * (attempt + 1));
    }
  }
  throw lastError ?? new Error("Amplitude export failed");
}

async function pullExportRange(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<RawEventFull[]> {
  const chunks = [...exportHourChunks(startHour, endHour)];
  if (chunks.length === 0 && startHour <= endHour) {
    throw new Error(`Invalid Amplitude export window ${startHour}..${endHour} (no hour chunks)`);
  }
  const events: RawEventFull[] = [];
  for (const [chunkStart, chunkEnd] of chunks) {
    events.push(...(await pullExport(env, chunkStart, chunkEnd)));
  }
  return events;
}

function eventTimeToIso(eventTime: string): string | null {
  if (!eventTime) return null;
  const normalized = eventTime.replace(" ", "T") + (eventTime.endsWith("Z") ? "" : "Z");
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toEventRows(events: RawEventFull[]) {
  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const ev of events) {
    const insert_id = ev.$insert_id ?? ev.insert_id;
    const iso = eventTimeToIso(ev.event_time ?? "");
    if (!insert_id || !iso || !ev.event_type) continue;
    if (seen.has(insert_id)) continue;
    seen.add(insert_id);
    rows.push({
      insert_id,
      event_time: iso,
      event_type: ev.event_type,
      user_id: ev.user_id ?? null,
      device_id: ev.device_id ?? null,
      session_id: ev.session_id ?? null,
      amplitude_id: ev.amplitude_id ?? null,
      app: ev.app ?? null,
      platform: ev.platform ?? null,
      country: ev.country ?? null,
      region: ev.region ?? null,
      city: ev.city ?? null,
      os_name: ev.os_name ?? null,
      device_family: ev.device_family ?? null,
      library: ev.library ?? null,
      event_properties: ev.event_properties ?? null,
      user_properties: ev.user_properties ?? null,
      raw: ev,
    });
  }
  return rows;
}

async function upsertEvents(
  env: StatsEnv,
  rows: Array<Record<string, unknown>>,
): Promise<void> {
  if (rows.length === 0) return;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const res = await sbFetch(env, "/rest/v1/amplitude_events?on_conflict=insert_id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      throw new Error(
        `Supabase upsert amplitude_events ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
  }
}

export async function syncAmplitudeExport(env: StatsEnv): Promise<void> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_SECRET_KEY) {
    console.warn("[celina-stats-api] skip Amplitude sync: missing API key/secret");
    return;
  }

  const { last_synced_at } = await getSyncState(env);
  const lastSynced = new Date(last_synced_at);
  const now = new Date();
  if (now.getTime() - lastSynced.getTime() < CACHE_GATE_MS) {
    return;
  }

  const yesterdayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const start = lastSynced < yesterdayStart ? lastSynced : yesterdayStart;
  const startHour = ymdh(start);
  const endRef = new Date(now.getTime() - 60 * 60 * 1000);
  const endHour = ymdh(endRef);
  if (endHour < startHour) {
    await setSyncState(env, now.toISOString());
    return;
  }

  const events = await pullExportRange(env, startHour, endHour);
  const rows = toEventRows(events);
  await upsertEvents(env, rows);
  await setSyncState(env, now.toISOString());
}

export type AmplitudeBackfillResult = {
  pulled: number;
  upserted: number;
};

/**
 * Force an Amplitude export -> Supabase upsert for an explicit `[startHour, endHour]`
 * window (format `YYYYMMDDTHH`, matching {@link syncAmplitudeExport}'s internal hour
 * format), bypassing the 24h {@link CACHE_GATE_MS} gate.
 *
 * Ad-hoc/manual use only (e.g. one-off gap backfills) — normal operation should
 * go through {@link syncAmplitudeExport} on the daily cron.
 */
export async function runAmplitudeBackfill(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<AmplitudeBackfillResult> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_SECRET_KEY) {
    throw new Error("Missing AMPLITUDE_API_KEY or AMPLITUDE_SECRET_KEY");
  }

  const events = await pullExportRange(env, startHour, endHour);
  const rows = toEventRows(events);
  await upsertEvents(env, rows);
  await setSyncState(env, new Date().toISOString());

  return { pulled: events.length, upserted: rows.length };
}

export async function readOffchainStats(env: StatsEnv): Promise<AmplitudeStatsResult> {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - LOOKBACK_DAYS);
  const sinceDay = since.toISOString().slice(0, 10);

  const [dailyRes, toolRes, stateRes, walletsDailyRes] = await Promise.all([
    sbFetch(
      env,
      `/rest/v1/amplitude_daily_totals?select=day,count&day=gte.${sinceDay}&order=day.asc`,
    ),
    sbFetch(env, `/rest/v1/amplitude_tool_totals?select=event,count&order=count.desc`),
    sbFetch(env, `/rest/v1/amplitude_sync_state?select=last_synced_at&id=eq.1`),
    sbFetch(
      env,
      `/rest/v1/amplitude_daily_queried_wallets?select=day,count&day=gte.${sinceDay}&order=day.asc`,
    ),
  ]);
  if (!dailyRes.ok) {
    throw new Error(
      `Supabase read daily_totals ${dailyRes.status}: ${(await dailyRes.text()).slice(0, 200)}`,
    );
  }
  if (!toolRes.ok) {
    throw new Error(
      `Supabase read tool_totals ${toolRes.status}: ${(await toolRes.text()).slice(0, 200)}`,
    );
  }
  if (!walletsDailyRes.ok) {
    throw new Error(
      `Supabase read daily_queried_wallets ${walletsDailyRes.status}: ${(await walletsDailyRes.text()).slice(0, 200)}`,
    );
  }
  const dailyRows = (await dailyRes.json()) as Array<{ day: string; count: number }>;
  const toolRows = (await toolRes.json()) as Array<{ event: string; count: number }>;
  const walletDailyRows = (await walletsDailyRes.json()) as Array<{
    day: string;
    count: number;
  }>;
  let lastSyncedAt: string | null = null;
  if (stateRes.ok) {
    const stateRows = (await stateRes.json()) as Array<{ last_synced_at: string }>;
    lastSyncedAt = stateRows[0]?.last_synced_at ?? null;
  }

  const daily: AmplitudeEventDay[] = dailyRows.map((r) => ({ day: r.day, count: r.count }));
  const perTool: AmplitudeEventTotal[] = toolRows.map((r) => ({
    event: r.event,
    count: r.count,
  }));
  const dailyWalletsQueried: AmplitudeEventDay[] = walletDailyRows.map((r) => ({
    day: r.day,
    count: r.count,
  }));
  const total = daily.reduce((s, d) => s + d.count, 0);
  const [uniqueDevices, walletsQueried] = await Promise.all([
    sbRpcScalar(env, "amplitude_unique_device_count", { since_day: sinceDay }),
    sbRpcScalar(env, "amplitude_wallets_queried_total", { since_day: sinceDay }),
  ]);

  return {
    daily,
    dailyWalletsQueried,
    perTool,
    total,
    uniqueDevices,
    walletsQueried,
    lastSyncedAt,
  };
}
