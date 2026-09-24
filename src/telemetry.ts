/** Amplitude HTTP API v2. The write key stays on this Worker. */
export const AMPLITUDE_HTTP_API_URL = "https://api2.amplitude.com/2/httpapi";

const MAX_LEN = {
  event_type: 80,
  device_id: 128,
  insert_id: 64,
  user_id: 64,
} as const;

const ALLOWED_FIELDS = new Set([
  "event_type",
  "device_id",
  "insert_id",
  "time",
  "user_id",
]);

export type TelemetryEvent = {
  event_type: string;
  device_id: string;
  insert_id: string;
  time: number;
  user_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max) return null;
  return trimmed;
}

export function parseTelemetryBody(
  body: unknown,
): { ok: true; event: TelemetryEvent } | { ok: false; error: string } {
  if (!isRecord(body)) {
    return { ok: false, error: "JSON body must be an object" };
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { ok: false, error: "Unexpected field" };
    }
  }

  const event_type = boundedString(body.event_type, MAX_LEN.event_type);
  const device_id = boundedString(body.device_id, MAX_LEN.device_id);
  const insert_id = boundedString(body.insert_id, MAX_LEN.insert_id);
  if (!event_type || !device_id || !insert_id) {
    return { ok: false, error: "event_type, device_id, and insert_id are required" };
  }
  if (typeof body.time !== "number" || !Number.isFinite(body.time)) {
    return { ok: false, error: "time must be a finite number" };
  }

  const event: TelemetryEvent = {
    event_type,
    device_id,
    insert_id,
    time: body.time,
  };
  if (body.user_id !== undefined) {
    const user_id = boundedString(body.user_id, MAX_LEN.user_id);
    if (!user_id) return { ok: false, error: "user_id is invalid" };
    event.user_id = user_id;
  }
  return { ok: true, event };
}

/** Forward one event. Returns whether Amplitude accepted it. */
export async function forwardTelemetryEvent(
  apiKey: string,
  event: TelemetryEvent,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  const res = await doFetch(AMPLITUDE_HTTP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      events: [
        {
          event_type: event.event_type,
          device_id: event.device_id,
          insert_id: event.insert_id,
          time: event.time,
          ...(event.user_id ? { user_id: event.user_id } : {}),
        },
      ],
    }),
  });
  return res.ok;
}
