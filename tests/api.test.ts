import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { isTxHash } from "../src/onchain.js";

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
