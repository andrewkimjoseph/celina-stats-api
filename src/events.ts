import type { StatsEnv } from "./env.js";
import { sbFetch } from "./supabase.js";

export type EventPayload = {
  insertId: string;
  event: string;
  deviceId: string;
  userId?: string;
  occurredAt: string;
};

const MAX_STRING_LENGTH = 512;

function isNonEmptyString(value: unknown, maxLength = MAX_STRING_LENGTH): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
  );
}

function isIsoDateString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/** Validate an incoming `POST /events` body — SDK usage-event ingest from celina-sdk. */
export function isValidEventPayload(body: unknown): body is EventPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const b = body as Record<string, unknown>;
  if (!isNonEmptyString(b.insertId)) return false;
  if (!isNonEmptyString(b.event)) return false;
  if (!isNonEmptyString(b.deviceId)) return false;
  if (!isIsoDateString(b.occurredAt)) return false;
  if (b.userId !== undefined && !isNonEmptyString(b.userId)) return false;
  return true;
}

export type IngestEventResult = { ok: true } | { ok: false; status: 400 | 502; error: string };

/**
 * Insert an SDK-reported usage event straight into Supabase, using the same
 * `amplitude_events` row shape (and `insert_id` dedupe) that the Amplitude export
 * cron already populates. Off-chain dashboard aggregates are computed by celina-api.
 */
export async function ingestEvent(
  env: StatsEnv,
  payload: EventPayload,
): Promise<IngestEventResult> {
  const row = {
    insert_id: payload.insertId,
    event_time: new Date(payload.occurredAt).toISOString(),
    event_type: payload.event,
    user_id: payload.userId ?? null,
    device_id: payload.deviceId,
    library: "celina-sdk",
    raw: payload,
  };

  try {
    const res = await sbFetch(env, "/rest/v1/amplitude_events?on_conflict=insert_id", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        error: `Supabase upsert amplitude_events ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: message };
  }
}
