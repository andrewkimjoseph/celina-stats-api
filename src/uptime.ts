import type { StatsEnv } from "./env.js";

export const DEGRADED_LATENCY_MS = 1000;
export const PING_TIMEOUT_MS = 8_000;
export const UPTIME_HISTORY_DAYS = 30;
const KV_PREFIX = "uptime:";

export const MONITORED_SERVICES = [
  { id: "mcp", name: "MCP Remote", url: "https://mcp.usecelina.xyz/health" },
  { id: "api", name: "API", url: "https://api.usecelina.xyz/health" },
  { id: "bot", name: "Bot", url: "https://bot.usecelina.xyz/health" },
  { id: "stats", name: "Stats API", url: "https://api.stats.usecelina.xyz/health" },
  { id: "website", name: "Website", url: "https://usecelina.xyz/" },
  { id: "celeste", name: "Celeste AI", url: "https://celeste.usecelina.xyz/" },
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

export async function writeUptimeRecord(
  env: StatsEnv,
  date: string,
  results: ServicePing[],
): Promise<void> {
  if (!env.UPTIME_STORE) {
    console.warn("[celina-stats-api] UPTIME_STORE is not bound; skipping uptime write");
    return;
  }
  const record: UptimeDay = { date, results };
  await env.UPTIME_STORE.put(`${KV_PREFIX}${date}`, JSON.stringify(record));
}

export async function recordDailyUptime(env: StatsEnv, now = new Date()): Promise<ServicePing[]> {
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

export async function readUptimeHistory(env: StatsEnv): Promise<UptimeDay[]> {
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

  const recent = names.sort().slice(-UPTIME_HISTORY_DAYS);
  const days = await Promise.all(
    recent.map(async (name) => parseDay(await store.get(name))),
  );
  return days.filter((day): day is UptimeDay => day !== null);
}
