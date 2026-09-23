import { gunzipSync, strFromU8, unzipSync } from "fflate";
import type { StatsEnv } from "./env.js";
import { sbFetch } from "./supabase.js";

const HOUR_MS = 60 * 60 * 1000;
/** Amplitude publishes an hour about 2 hours after that hour closes. */
const EXPORT_LAG_MS = 2 * HOUR_MS;
/** Re-read this much before the cursor so a late file in the last hour is not missed. */
const EXPORT_OVERLAP_MS = 2 * HOUR_MS;
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

/**
 * Last export hour whose close is at least {@link EXPORT_LAG_MS} in the past.
 * At 06:00 UTC that is hour 03: hour 03 ends at 04:00 and is exportable at 06:00.
 */
export function latestClosedHour(now: Date): string {
  const cutoff = now.getTime() - EXPORT_LAG_MS;
  const hourEnd = Math.floor(cutoff / HOUR_MS) * HOUR_MS;
  return ymdh(new Date(hourEnd - HOUR_MS));
}

/** ISO timestamp of the instant the given export hour ends (exclusive). */
export function endOfHourIso(hour: string): string {
  return new Date(parseYmdh(hour).getTime() + HOUR_MS).toISOString();
}

function* hoursInclusive(startHour: string, endHour: string): Generator<string> {
  let cur = parseYmdh(startHour);
  const end = parseYmdh(endHour);
  while (cur <= end) {
    yield ymdh(cur);
    cur = new Date(cur.getTime() + HOUR_MS);
  }
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

type ExportBatch =
  | { kind: "events"; events: RawEventFull[] }
  | { kind: "absent" };

async function pullExportOnce(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<ExportBatch> {
  const url = new URL(`${amplitudeBaseUrl(env)}/api/2/export`);
  url.searchParams.set("start", startHour);
  url.searchParams.set("end", endHour);

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader(env) },
  });
  if (res.status === 404) {
    await res.body?.cancel();
    return { kind: "absent" };
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
  return { kind: "events", events };
}

async function pullExport(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<ExportBatch> {
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

type PullOutcome = {
  events: RawEventFull[];
  /** Latest closed hour returned 404. Retry it next run; do not treat it as empty. */
  retryHour: string | null;
  completedThroughHour: string | null;
};

async function pullExportRange(
  env: StatsEnv,
  startHour: string,
  endHour: string,
): Promise<PullOutcome> {
  const chunks = [...exportHourChunks(startHour, endHour)];
  if (chunks.length === 0 && startHour <= endHour) {
    throw new Error(`Invalid Amplitude export window ${startHour}..${endHour} (no hour chunks)`);
  }
  const events: RawEventFull[] = [];
  let completedThroughHour: string | null = null;

  for (const [chunkStart, chunkEnd] of chunks) {
    const chunk = await pullExport(env, chunkStart, chunkEnd);
    if (chunk.kind === "events") {
      events.push(...chunk.events);
      completedThroughHour = chunkEnd;
      continue;
    }

    // A multi-hour 404 hides every hour in the chunk. Walk them one by one so
    // an empty hour does not drop its neighbors. Only the latest closed hour
    // stops the run: an older 404 is a closed hour with no events, and
    // refusing to pass it would stall the cursor on every quiet stretch.
    for (const hour of hoursInclusive(chunkStart, chunkEnd)) {
      const one = await pullExport(env, hour, hour);
      if (one.kind === "events") {
        events.push(...one.events);
        completedThroughHour = hour;
        continue;
      }
      if (hour === endHour) {
        return { events, retryHour: hour, completedThroughHour };
      }
      completedThroughHour = hour;
    }
  }

  return { events, retryHour: null, completedThroughHour };
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

export type AmplitudeSyncResult =
  | { status: "skipped"; reason: "missing_credentials" }
  | { status: "empty_window"; cursor: string; closedHour: string }
  | {
      status: "partial";
      failedHour: string;
      pulled: number;
      upserted: number;
      startHour: string;
      endHour: string;
    }
  | {
      status: "synced";
      pulled: number;
      upserted: number;
      startHour: string;
      endHour: string;
    };

export async function syncAmplitudeExport(
  env: StatsEnv,
  now = new Date(),
): Promise<AmplitudeSyncResult> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_SECRET_KEY) {
    return { status: "skipped", reason: "missing_credentials" };
  }

  const { last_synced_at } = await getSyncState(env);
  const cursor = new Date(last_synced_at);
  const closedHour = latestClosedHour(now);
  const closedThrough = new Date(endOfHourIso(closedHour));
  if (cursor.getTime() >= closedThrough.getTime()) {
    return {
      status: "empty_window",
      cursor: cursor.toISOString(),
      closedHour,
    };
  }

  const floor = new Date(SYNC_FLOOR_ISO);
  const overlapped = new Date(cursor.getTime() - EXPORT_OVERLAP_MS);
  const start = overlapped < floor ? floor : overlapped;
  const startHour = ymdh(start);
  if (closedHour < startHour) {
    return {
      status: "empty_window",
      cursor: cursor.toISOString(),
      closedHour,
    };
  }

  const pull = await pullExportRange(env, startHour, closedHour);
  const rows = toEventRows(pull.events);
  await upsertEvents(env, rows);

  if (pull.retryHour) {
    await setSyncState(env, parseYmdh(pull.retryHour).toISOString());
    return {
      status: "partial",
      failedHour: pull.retryHour,
      pulled: pull.events.length,
      upserted: rows.length,
      startHour,
      endHour: closedHour,
    };
  }

  await setSyncState(env, endOfHourIso(closedHour));
  return {
    status: "synced",
    pulled: pull.events.length,
    upserted: rows.length,
    startHour,
    endHour: closedHour,
  };
}

export type AmplitudeBackfillResult = {
  pulled: number;
  upserted: number;
  status: "synced" | "partial";
  failedHour?: string;
  cursor: string;
  startHour: string;
  endHour: string;
};

/**
 * Force an Amplitude export -> Supabase upsert for an explicit `[startHour, endHour]`
 * window (format `YYYYMMDDTHH`). The end hour is capped at {@link latestClosedHour}
 * so the cursor never moves into an hour Amplitude has not published.
 *
 * Ad-hoc/manual use only — the midnight cron goes through {@link syncAmplitudeExport}.
 */
export async function runAmplitudeBackfill(
  env: StatsEnv,
  startHour: string,
  endHour: string,
  now = new Date(),
): Promise<AmplitudeBackfillResult> {
  if (!env.AMPLITUDE_API_KEY || !env.AMPLITUDE_SECRET_KEY) {
    throw new Error("Missing AMPLITUDE_API_KEY or AMPLITUDE_SECRET_KEY");
  }

  const closedHour = latestClosedHour(now);
  const cappedEnd = endHour < closedHour ? endHour : closedHour;
  const { last_synced_at } = await getSyncState(env);
  if (cappedEnd < startHour) {
    return {
      pulled: 0,
      upserted: 0,
      status: "synced",
      cursor: new Date(last_synced_at).toISOString(),
      startHour,
      endHour: cappedEnd,
    };
  }

  const pull = await pullExportRange(env, startHour, cappedEnd);
  const rows = toEventRows(pull.events);
  await upsertEvents(env, rows);

  const retryAt = pull.retryHour ? parseYmdh(pull.retryHour).toISOString() : null;
  const completedThrough = endOfHourIso(pull.completedThroughHour ?? cappedEnd);
  const closedEnd = endOfHourIso(closedHour);
  let nextCursor = retryAt ?? (
    new Date(completedThrough).getTime() > new Date(last_synced_at).getTime()
      ? completedThrough
      : new Date(last_synced_at).toISOString()
  );
  if (new Date(nextCursor).getTime() > new Date(closedEnd).getTime()) {
    nextCursor = closedEnd;
  }
  if (new Date(nextCursor).getTime() !== new Date(last_synced_at).getTime()) {
    await setSyncState(env, nextCursor);
  }

  return {
    pulled: pull.events.length,
    upserted: rows.length,
    status: pull.retryHour ? "partial" : "synced",
    failedHour: pull.retryHour ?? undefined,
    cursor: nextCursor,
    startHour,
    endHour: cappedEnd,
  };
}
