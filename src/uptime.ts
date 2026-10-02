import type { StatsEnv } from "./env.js";

export const DEGRADED_LATENCY_MS = 1000;
export const PING_TIMEOUT_MS = 8_000;
export const UPTIME_HISTORY_DAYS = 30;
/** First day the hosted stack was recorded. Missing only until the first hourly run copies it. */
export const UPTIME_RECORDING_START = "2026-09-30";
const KV_PREFIX = "uptime:";

const STATUS_RANK: Record<ServiceStatus, number> = {
  operational: 0,
  degraded: 1,
  down: 2,
};

export const MONITORED_SERVICES = [
  { id: "mcp", name: "MCP Remote", url: "https://mcp.usecelina.xyz/health" },
  { id: "api", name: "API", url: "https://api.usecelina.xyz/health" },
  { id: "bot", name: "Bot", url: "https://bot.usecelina.xyz/health" },
  { id: "stats", name: "Stats API", url: "https://api.stats.usecelina.xyz/health" },
  { id: "website", name: "Website", url: "https://usecelina.xyz/" },
  { id: "celeste", name: "Celeste AI", url: "https://celeste.usecelina.xyz/" },
  { id: "chat", name: "Celina Chat", url: "https://chat.usecelina.xyz/" },
] as const;

export type ServiceId = (typeof MONITORED_SERVICES)[number]["id"];
export type ServiceStatus = "operational" | "degraded" | "down";

export type ServicePing = {
  id: ServiceId;
  name: string;
  url: string;
  status: ServiceStatus;
  latencyMs: number | null;
  ok: boolean;
};

export type UptimeDay = {
  date: string;
  results: ServicePing[];
};

export function statusFromResponse(ok: boolean, latencyMs: number | null): ServiceStatus {
  if (!ok || latencyMs === null) return "down";
  if (latencyMs > DEGRADED_LATENCY_MS) return "degraded";
  return "operational";
}

export function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function selfPing(service: (typeof MONITORED_SERVICES)[number]): ServicePing {
  return {
    id: service.id,
    name: service.name,
    url: service.url,
    status: "operational",
    latencyMs: 0,
    ok: true,
  };
}

async function pingOne(
  service: (typeof MONITORED_SERVICES)[number],
  doFetch: typeof fetch,
): Promise<ServicePing> {
  // The cron runs inside this Worker. Fetching its own public URL is rejected
  // by Cloudflare (error 1042), so record Stats API in-process instead.
  if (service.id === "stats") return selfPing(service);

  const started = Date.now();
  try {
    const res = await doFetch(service.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    const latencyMs = Date.now() - started;
    await res.body?.cancel();
    const ok = res.ok;
    return {
      id: service.id,
      name: service.name,
      url: service.url,
      status: statusFromResponse(ok, latencyMs),
      latencyMs,
      ok,
    };
  } catch {
    return {
      id: service.id,
      name: service.name,
      url: service.url,
      status: "down",
      latencyMs: null,
      ok: false,
    };
  }
}

export async function pingAllServices(doFetch: typeof fetch = fetch): Promise<ServicePing[]> {
  return Promise.all(MONITORED_SERVICES.map((service) => pingOne(service, doFetch)));
}

function worsePing(previous: ServicePing, next: ServicePing): ServicePing {
  return STATUS_RANK[next.status] > STATUS_RANK[previous.status] ? next : previous;
}

function mergeDayResults(previous: ServicePing[], next: ServicePing[]): ServicePing[] {
  const prior = new Map(previous.map((row) => [row.id, row]));
  const incoming = new Map(next.map((row) => [row.id, row]));
  const ids = MONITORED_SERVICES.map((service) => service.id);
  const extra = [...new Set([...prior.keys(), ...incoming.keys()])].filter(
    (id) => !ids.includes(id as ServiceId),
  );
  return [...ids, ...extra].flatMap((id) => {
    const oldRow = prior.get(id as ServiceId);
    const newRow = incoming.get(id as ServiceId);
    if (oldRow && newRow) return [worsePing(oldRow, newRow)];
    if (newRow) return [newRow];
    if (oldRow) return [oldRow];
    return [];
  });
}

export async function writeUptimeRecord(
  env: StatsEnv,
  date: string,
  results: ServicePing[],
): Promise<void> {
  if (!env.UPTIME_STORE) {
    console.warn("[celina-stats-api] UPTIME_STORE is not bound; skipping uptime write");
    return;
  }
  const key = `${KV_PREFIX}${date}`;
  const existing = parseDay(await env.UPTIME_STORE.get(key));
  const merged = existing ? mergeDayResults(existing.results, results) : results;
  const record: UptimeDay = { date, results: merged };
  await env.UPTIME_STORE.put(key, JSON.stringify(record));
}

/**
 * Copy the earliest stored day onto {@link UPTIME_RECORDING_START} once.
 * Does nothing when that key exists, or when no later day has been stored.
 */
export async function backfillRecordingStart(env: StatsEnv): Promise<void> {
  const store = env.UPTIME_STORE;
  if (!store) return;
  const startKey = `${KV_PREFIX}${UPTIME_RECORDING_START}`;
  if (await store.get(startKey)) return;

  const days = await listUptimeDays(env);
  const earliest = days
    .filter((day) => day.date > UPTIME_RECORDING_START)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!earliest) return;

  await store.put(
    startKey,
    JSON.stringify({ date: UPTIME_RECORDING_START, results: earliest.results }),
  );
}

export async function recordDailyUptime(env: StatsEnv, now = new Date()): Promise<ServicePing[]> {
  await backfillRecordingStart(env);
  const results = await pingAllServices();
  await writeUptimeRecord(env, utcDay(now), results);
  return results;
}

function parseDay(raw: string | null): UptimeDay | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UptimeDay>;
    if (typeof value.date !== "string" || !Array.isArray(value.results)) return null;
    return { date: value.date, results: value.results };
  } catch {
    return null;
  }
}

async function listUptimeDays(env: StatsEnv): Promise<UptimeDay[]> {
  const store = env.UPTIME_STORE;
  if (!store) return [];

  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const listed = await store.list({ prefix: KV_PREFIX, cursor });
    for (const key of listed.keys) names.push(key.name);
    if (listed.list_complete || !listed.cursor) break;
    cursor = listed.cursor;
  }

  const days = await Promise.all(
    names.sort().map(async (name) => parseDay(await store.get(name))),
  );
  return days.filter((day): day is UptimeDay => day !== null);
}

export async function readUptimeHistory(env: StatsEnv): Promise<UptimeDay[]> {
  const days = await listUptimeDays(env);
  return days.slice(-UPTIME_HISTORY_DAYS);
}
