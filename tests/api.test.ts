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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
