import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
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

  it("POST /telemetry forwards one event to Amplitude", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    try {
      const res = await app.request(
        "/telemetry",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event_type: "get_wallet_address",
            device_id: "celina_api",
            insert_id: "abc",
            time: 1,
            user_id: "0x1234567890123456789012345678901234567890",
          }),
        },
        { AMPLITUDE_API_KEY: "test-key" },
      );
      expect(res.status).toBe(204);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe("https://api2.amplitude.com/2/httpapi");
      const body = JSON.parse(String(calls[0]?.init?.body));
      expect(body.api_key).toBe("test-key");
      expect(body.events).toEqual([
        {
          event_type: "get_wallet_address",
          device_id: "celina_api",
          insert_id: "abc",
          time: 1,
          user_id: "0x1234567890123456789012345678901234567890",
        },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("POST /telemetry rejects an unexpected field", async () => {
    const res = await app.request(
      "/telemetry",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_type: "get_wallet_address",
          device_id: "celina_api",
          insert_id: "abc",
          time: 1,
          api_key: "stolen",
        }),
      },
      { AMPLITUDE_API_KEY: "test-key" },
    );
    expect(res.status).toBe(400);
  });

  it("POST /telemetry returns 503 when the write key is unset", async () => {
    const res = await app.request("/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_type: "get_wallet_address",
        device_id: "celina_api",
        insert_id: "abc",
        time: 1,
      }),
    });
    expect(res.status).toBe(503);
  });

  it("POST /telemetry returns 429 when the rate limiter rejects", async () => {
    const res = await app.request(
      "/telemetry",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.9",
        },
        body: JSON.stringify({
          event_type: "get_wallet_address",
          device_id: "celina_api",
          insert_id: "abc",
          time: 1,
        }),
      },
      {
        AMPLITUDE_API_KEY: "test-key",
        TELEMETRY_RATE_LIMITER: {
          limit: async ({ key }) => {
            expect(key).toBe("203.0.113.9");
            return { success: false };
          },
        },
      },
    );
    expect(res.status).toBe(429);
  });

  it("POST /events is gone", async () => {
    const res = await app.request("/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        insertId: "abc123",
        event: "get_wallet_address",
        deviceId: "celina_sdk",
        occurredAt: "2026-09-08T12:00:00.000Z",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /onchain returns 429 when the rate limiter rejects", async () => {
    const res = await app.request(
      "/onchain",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Connecting-IP": "203.0.113.4",
        },
        body: JSON.stringify({ hash: `0x${"ab".repeat(32)}` }),
      },
      {
        ONCHAIN_RATE_LIMITER: {
          limit: async ({ key }) => {
            expect(key).toBe("203.0.113.4");
            return { success: false };
          },
        },
      },
    );
    expect(res.status).toBe(429);
  });

  it("GET /onchain, /offchain, and /package require the read key", async () => {
    for (const path of ["/onchain", "/offchain/daily", "/package"]) {
      const missing = await app.request(path, undefined, { STATS_READ_KEY: "secret" });
      expect(missing.status).toBe(401);
      const wrong = await app.request(
        path,
        { headers: { Authorization: "Bearer other" } },
        { STATS_READ_KEY: "secret" },
      );
      expect(wrong.status).toBe(401);
    }
    const unset = await app.request("/offchain/daily");
    expect(unset.status).toBe(401);
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

const READ_KEY = "test-read-key";

const supabaseEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  STATS_READ_KEY: READ_KEY,
};

function readRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Authorization: `Bearer ${READ_KEY}` },
  });
}

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
      const res = await app.request(readRequest("/offchain/daily"), undefined, supabaseEnv);
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
      const res = await app.request(readRequest("/offchain/events"), undefined, supabaseEnv);
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
    const res = await app.request(readRequest("/offchain/daily"), undefined, {
      STATS_READ_KEY: READ_KEY,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/SUPABASE_/);
  });
});
