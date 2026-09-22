import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { isValidEventPayload } from "../src/events.js";
import { isTxHash } from "../src/onchain.js";
import {
  mergeDownloads,
  PACKAGES,
  readPackageStats,
} from "../src/package.js";

describe("HTTP surface", () => {
  const app = createApp();

  it("GET /health", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      service: "celina-stats-api",
    });
  });

  it("POST /onchain rejects invalid hash", async () => {
    const res = await app.request("/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hash: "not-a-hash" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/hash/i);
  });

  it("POST /onchain rejects missing body", async () => {
    const res = await app.request("/onchain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("OPTIONS /onchain allows CORS", async () => {
    const res = await app.request("/onchain", {
      method: "OPTIONS",
      headers: {
        Origin: "https://usecelina.xyz",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("POST /events rejects missing fields", async () => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: "get_wallet_address" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/invalid event payload/i);
  });

  it("POST /events rejects missing body", async () => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("POST /events rejects a non-ISO occurredAt", async () => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        insertId: "abc123",
        event: "get_wallet_address",
        deviceId: "celina_sdk",
        occurredAt: "not-a-date",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("OPTIONS /events allows CORS", async () => {
    const res = await app.request("/events", {
      method: "OPTIONS",
      headers: {
        Origin: "https://usecelina.xyz",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("isValidEventPayload", () => {
  const valid = {
    insertId: "insert-1",
    event: "get_wallet_address",
    deviceId: "celina_sdk",
    occurredAt: "2026-09-08T12:00:00.000Z",
  };

  it("accepts a well-formed payload", () => {
    expect(isValidEventPayload(valid)).toBe(true);
  });

  it("accepts an optional userId", () => {
    expect(
      isValidEventPayload({
        ...valid,
        userId: "0x1234567890123456789012345678901234567890",
      }),
    ).toBe(true);
  });

  it("rejects missing insertId", () => {
    const { insertId: _insertId, ...rest } = valid;
    expect(isValidEventPayload(rest)).toBe(false);
  });

  it("rejects missing event", () => {
    const { event: _event, ...rest } = valid;
    expect(isValidEventPayload(rest)).toBe(false);
  });

  it("rejects missing deviceId", () => {
    const { deviceId: _deviceId, ...rest } = valid;
    expect(isValidEventPayload(rest)).toBe(false);
  });

  it("rejects a non-ISO occurredAt", () => {
    expect(isValidEventPayload({ ...valid, occurredAt: "not-a-date" })).toBe(false);
  });

  it("rejects a non-string userId", () => {
    expect(isValidEventPayload({ ...valid, userId: 123 })).toBe(false);
  });

  it("rejects non-object bodies", () => {
    expect(isValidEventPayload(null)).toBe(false);
    expect(isValidEventPayload("string")).toBe(false);
    expect(isValidEventPayload([valid])).toBe(false);
  });
});

describe("isTxHash", () => {
  it("accepts 32-byte hex", () => {
    expect(
      isTxHash("0x" + "ab".repeat(32)),
    ).toBe(true);
  });

  it("rejects short or unprefixed values", () => {
    expect(isTxHash("0xabc")).toBe(false);
    expect(isTxHash("ab".repeat(32))).toBe(false);
  });
});

describe("mergeDownloads", () => {
  it("sums the same day across packages and sorts", () => {
    expect(
      mergeDownloads([
        [
          { day: "2026-09-02", downloads: 3 },
          { day: "2026-09-01", downloads: 1 },
        ],
        [{ day: "2026-09-01", downloads: 4 }],
      ]),
    ).toEqual([
      { day: "2026-09-01", downloads: 5 },
      { day: "2026-09-02", downloads: 3 },
    ]);
  });
});

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("readPackageStats", () => {
  const now = new Date("2026-09-07T19:00:00.000Z");

  it("merges successful package ranges", async () => {
    const doFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("celina-mcp")) {
        return jsonResponse({
          downloads: [{ day: "2026-09-01", downloads: 2 }],
        });
      }
      if (url.includes("celina-sdk")) {
        return jsonResponse({
          downloads: [{ day: "2026-09-01", downloads: 5 }],
        });
      }
      return jsonResponse({ downloads: [] });
    };

    const stats = await readPackageStats(doFetch, now);
    expect(stats.rows).toEqual([{ day: "2026-09-01", downloads: 7 }]);
    expect(stats.partial).toBe(false);
    expect(stats.failedPackages).toEqual([]);
    expect(stats.error).toBeUndefined();
    expect(stats.lastSyncedAt).toBe(now.toISOString());
  });

  it("returns partial when one package fails", async () => {
    const doFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("celina-mcp")) {
        return jsonResponse({ error: "nope" }, 500);
      }
      return jsonResponse({
        downloads: [{ day: "2026-09-01", downloads: 1 }],
      });
    };

    const stats = await readPackageStats(doFetch, now);
    expect(stats.rows).toEqual([{ day: "2026-09-01", downloads: 2 }]);
    expect(stats.partial).toBe(true);
    expect(stats.failedPackages.some((line) => line.includes(PACKAGES[0]))).toBe(
      true,
    );
    expect(stats.error).toMatch(/Partial npm data/);
  });

  it("returns an error when every package fails", async () => {
    const doFetch: typeof fetch = async () => jsonResponse({ error: "down" }, 500);

    const stats = await readPackageStats(doFetch, now);
    expect(stats.rows).toEqual([]);
    expect(stats.partial).toBe(false);
    expect(stats.failedPackages).toHaveLength(PACKAGES.length);
    expect(stats.error).toBeTruthy();
  });
});

const supabaseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
};

describe("GET /offchain/*", () => {
  const app = createApp();

  it("GET /offchain/daily aggregates rows", async () => {
    const fetchMock = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method).toBe("POST");
      if (url.endsWith("/rest/v1/rpc/offchain_daily")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { since_day: string };
        expect(body.since_day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        return jsonResponse([
          { day: "2026-09-01", count: 2 },
          { day: "2026-09-02", count: 3 },
        ]);
      }
      if (url.endsWith("/rest/v1/rpc/offchain_total")) {
        return jsonResponse(12);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const res = await app.request("/offchain/daily", undefined, supabaseEnv);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        rows: [
          { day: "2026-09-01", count: 2 },
          { day: "2026-09-02", count: 3 },
        ],
        total: 12,
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("GET /offchain/events lists rows newest first", async () => {
    const fetchMock = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/rest/v1/amplitude_events")) {
        expect(url).toContain("order=event_time.desc");
        return jsonResponse(
          [
            {
              insert_id: "a",
              event_time: "2026-09-02T00:00:00.000Z",
              event_type: "get_token_balance",
              device_id: "the_good_pax_app",
            },
          ],
          200,
          { "content-range": "0-0/1" },
        );
      }
      if (url.includes("/rest/v1/amplitude_sync_state")) {
        return jsonResponse([{ last_synced_at: "2026-09-08T00:00:00.000Z" }]);
      }
      throw new Error(`unexpected fetch ${url}`);
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      const res = await app.request("/offchain/events", undefined, supabaseEnv);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({
        rows: [
          {
            insert_id: "a",
            event_time: "2026-09-02T00:00:00.000Z",
            event_type: "get_token_balance",
            device_id: "the_good_pax_app",
          },
        ],
        lastSyncedAt: "2026-09-08T00:00:00.000Z",
      });
    } finally {
      globalThis.fetch = original;
    }
  });

  it("GET /offchain/daily is 502 when Supabase is not configured", async () => {
    const res = await app.request("/offchain/daily");
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/SUPABASE_/);
  });
});
