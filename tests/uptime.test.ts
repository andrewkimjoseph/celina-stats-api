import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { UptimeStore } from "../src/env.js";
import {
  MONITORED_SERVICES,
  pingAllServices,
  readUptimeHistory,
  statusFromResponse,
  writeUptimeRecord,
  type ServicePing,
} from "../src/uptime.js";

function memoryStore(initial: Record<string, string> = {}): UptimeStore {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function ping(id: ServicePing["id"], status: ServicePing["status"]): ServicePing {
  const service = MONITORED_SERVICES.find((row) => row.id === id)!;
  return {
    id,
    name: service.name,
    url: service.url,
    status,
    latencyMs: status === "down" ? null : 20,
    ok: status !== "down",
  };
}

describe("uptime", () => {
  it("classifies response time", () => {
    expect(statusFromResponse(true, 40)).toBe("operational");
    expect(statusFromResponse(true, 1001)).toBe("degraded");
    expect(statusFromResponse(false, 20)).toBe("down");
    expect(statusFromResponse(true, null)).toBe("down");
  });

  it("pings every monitored service", async () => {
    const doFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("bot.")) return new Response("no", { status: 503 });
      if (url.includes("celeste.")) throw new Error("network");
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const results = await pingAllServices(doFetch);
    expect(results.map((row) => row.id)).toEqual(MONITORED_SERVICES.map((row) => row.id));
    expect(results.find((row) => row.id === "mcp")?.status).toBe("operational");
    expect(results.find((row) => row.id === "bot")?.status).toBe("down");
    expect(results.find((row) => row.id === "celeste")?.ok).toBe(false);
    expect(results.find((row) => row.id === "stats")?.status).toBe("operational");
  });

  it("does not HTTP-fetch the stats worker itself", async () => {
    const urls: string[] = [];
    const doFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response("no", { status: 503 });
    }) as typeof fetch;

    const results = await pingAllServices(doFetch);
    expect(urls.some((url) => url.includes("api.stats"))).toBe(false);
    expect(results.find((row) => row.id === "stats")).toMatchObject({
      status: "operational",
      ok: true,
      latencyMs: 0,
    });
  });

  it("keeps the latest 30 daily records", async () => {
    const store = memoryStore();
    const env = { UPTIME_STORE: store };
    for (let day = 1; day <= 31; day++) {
      const date = `2026-08-${String(day).padStart(2, "0")}`;
      await writeUptimeRecord(env, date, [ping("mcp", "operational")]);
    }
    const days = await readUptimeHistory(env);
    expect(days).toHaveLength(30);
    expect(days[0]?.date).toBe("2026-08-02");
    expect(days.at(-1)?.date).toBe("2026-08-31");
  });

  it("GET /uptime is public", async () => {
    const app = createApp();
    const empty = await app.request("/uptime");
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ days: [] });

    const store = memoryStore({
      "uptime:2026-09-30": JSON.stringify({
        date: "2026-09-30",
        results: [ping("api", "operational")],
      }),
    });
    const res = await app.request("/uptime", {}, { UPTIME_STORE: store });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: Array<{ date: string }> };
    expect(body.days.map((day) => day.date)).toEqual(["2026-09-30"]);
  });
});