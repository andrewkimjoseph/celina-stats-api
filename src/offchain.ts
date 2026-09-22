import type { StatsEnv } from "./env.js";
import { sbFetch, sbRpc } from "./supabase.js";

export const OFFCHAIN_LOOKBACK_DAYS = 90;
const SB_PAGE_SIZE = 1000;

export type OffchainDayCount = {
  day: string;
  count: number;
};

export type OffchainToolCount = {
  event: string;
  count: number;
};

export type OffchainProjectCount = {
  project: string;
  count: number;
};

export type OffchainEventRow = {
  insert_id: string;
  event_time: string;
  event_type: string;
  device_id: string;
};

type RpcDayRow = { day: string; count: number | string };
type RpcToolRow = { event: string; count: number | string };

export function sinceDay(now = new Date()): string {
  const since = new Date(now.getTime());
  since.setUTCDate(since.getUTCDate() - OFFCHAIN_LOOKBACK_DAYS);
  return since.toISOString().slice(0, 10);
}

function asCount(value: number | string | null | undefined): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function asDay(value: string): string {
  return value.slice(0, 10);
}

export async function readOffchainDaily(
  env: StatsEnv,
): Promise<{ rows: OffchainDayCount[]; total: number }> {
  const [dailyRows, total] = await Promise.all([
    sbRpc<RpcDayRow[]>(env, "offchain_daily", {
      since_day: sinceDay(),
    }),
    sbRpc<number | string | null>(env, "offchain_total", {}),
  ]);
  return {
    rows: dailyRows.map((row) => ({
      day: asDay(row.day),
      count: asCount(row.count),
    })),
    total: asCount(total),
  };
}

export async function readOffchainWallets(
  env: StatsEnv,
): Promise<{ daily: OffchainDayCount[]; total: number }> {
  const since_day = sinceDay();
  const [dailyRows, total] = await Promise.all([
    sbRpc<RpcDayRow[]>(env, "offchain_wallets_daily", { since_day }),
    sbRpc<number | string | null>(env, "offchain_wallets_total", { since_day }),
  ]);
  return {
    daily: dailyRows.map((row) => ({
      day: asDay(row.day),
      count: asCount(row.count),
    })),
    total: asCount(total),
  };
}

export async function readOffchainTools(
  env: StatsEnv,
): Promise<{ rows: OffchainToolCount[] }> {
  const rows = (
    await sbRpc<RpcToolRow[]>(env, "offchain_tools", {
      since_day: sinceDay(),
    })
  ).map((row) => ({ event: row.event, count: asCount(row.count) }));
  return { rows };
}

export async function readOffchainProjects(
  env: StatsEnv,
): Promise<{ rows: OffchainProjectCount[] }> {
  const rows = (
    await sbRpc<Array<{ project: string; count: number | string }>>(
      env,
      "offchain_projects",
      { since_day: sinceDay() },
    )
  ).map((row) => ({ project: row.project, count: asCount(row.count) }));
  return { rows };
}

export async function readOffchainDevices(
  env: StatsEnv,
): Promise<{ uniqueDevices: number }> {
  const uniqueDevices = await sbRpc<number | string | null>(
    env,
    "offchain_devices",
    { since_day: sinceDay() },
  );
  return { uniqueDevices: asCount(uniqueDevices) };
}

export async function readOffchainSync(
  env: StatsEnv,
): Promise<{ lastSyncedAt: string | null }> {
  const res = await sbFetch(
    env,
    "/rest/v1/amplitude_sync_state?select=last_synced_at&id=eq.1",
  );
  if (!res.ok) {
    throw new Error(
      `Supabase read amplitude_sync_state ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const rows = (await res.json()) as Array<{ last_synced_at: string | null }>;
  return { lastSyncedAt: rows[0]?.last_synced_at ?? null };
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const raw = header.slice(slash + 1).trim();
  if (raw === "*") return null;
  const total = Number(raw);
  return Number.isFinite(total) ? total : null;
}

function mapEventRow(r: Record<string, unknown>): OffchainEventRow | null {
  const insert_id = String(r.insert_id ?? "").trim();
  const event_time = String(r.event_time ?? "").trim();
  const event_type = String(r.event_type ?? "").trim();
  if (!insert_id || !event_time || !event_type) return null;
  return {
    insert_id,
    event_time,
    event_type,
    device_id: String(r.device_id ?? ""),
  };
}

export async function readOffchainEvents(env: StatsEnv): Promise<{
  rows: OffchainEventRow[];
  lastSyncedAt: string | null;
}> {
  const rows: OffchainEventRow[] = [];
  let from = 0;
  let expectedTotal: number | null = null;

  while (true) {
    const to = from + SB_PAGE_SIZE - 1;
    const res = await sbFetch(
      env,
      `/rest/v1/amplitude_events?select=insert_id,event_time,event_type,device_id&order=event_time.desc`,
      {
        headers: {
          Range: `${from}-${to}`,
          Prefer: "count=exact",
        },
      },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(
        `Supabase read amplitude_events ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const page = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of page) {
      const mapped = mapEventRow(r);
      if (mapped) rows.push(mapped);
    }
    if (expectedTotal === null) {
      expectedTotal = parseContentRangeTotal(res.headers.get("content-range"));
    }
    if (page.length === 0) break;
    if (expectedTotal !== null && rows.length >= expectedTotal) break;
    if (page.length < SB_PAGE_SIZE) break;
    from += page.length;
  }

  const { lastSyncedAt } = await readOffchainSync(env);
  return { rows, lastSyncedAt };
}

export function offchainErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
