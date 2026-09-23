import { gzipSync, strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  endOfHourIso,
  latestClosedHour,
  syncAmplitudeExport,
} from "../src/amplitude.js";
import type { StatsEnv } from "../src/env.js";

const env: StatsEnv = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  AMPLITUDE_API_KEY: "key",
  AMPLITUDE_SECRET_KEY: "secret",
};

function syncState(lastSyncedAt: string): Response {
  return Response.json([{ last_synced_at: lastSyncedAt }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("latestClosedHour", () => {
  it("is the hour that ended at least two hours ago", () => {
    expect(latestClosedHour(new Date("2026-09-23T06:00:00.000Z"))).toBe("20260923T03");
    expect(latestClosedHour(new Date("2026-09-23T06:30:00.000Z"))).toBe("20260923T03");
    expect(latestClosedHour(new Date("2026-09-23T07:00:00.000Z"))).toBe("20260923T04");
    expect(latestClosedHour(new Date("2026-09-23T00:00:22.000Z"))).toBe("20260922T21");
  });

  it("ends an hour at the next hour boundary", () => {
    expect(endOfHourIso("20260923T03")).toBe("2026-09-23T04:00:00.000Z");
  });
});

describe("syncAmplitudeExport", () => {
  it("skips when Amplitude credentials are missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncAmplitudeExport(
      { ...env, AMPLITUDE_API_KEY: undefined, AMPLITUDE_SECRET_KEY: undefined },
      new Date("2026-09-23T06:00:00.000Z"),
    );
    expect(result).toEqual({ status: "skipped", reason: "missing_credentials" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when the cursor is already through the latest closed hour", async () => {
    const fetchMock = vi.fn(async () => syncState("2026-09-23T04:00:00.000Z"));
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncAmplitudeExport(env, new Date("2026-09-23T06:00:00.000Z"));
    expect(result).toMatchObject({ status: "empty_window", closedHour: "20260923T03" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on a 404 for the latest closed hour and does not move the cursor to now", async () => {
    const patches: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("amplitude_sync_state") && (!init?.method || init.method === "GET")) {
        return syncState("2026-09-23T02:00:00.000Z");
      }
      if (url.includes("amplitude.com")) {
        return new Response(null, { status: 404 });
      }
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncAmplitudeExport(env, new Date("2026-09-23T06:00:00.000Z"));
    expect(result).toMatchObject({
      status: "partial",
      failedHour: "20260923T03",
      upserted: 0,
    });
    expect(patches).toEqual([
      expect.objectContaining({ last_synced_at: "2026-09-23T03:00:00.000Z" }),
    ]);
  });

  it("advances the cursor to the end of the last closed hour after a successful export", async () => {
    const line = JSON.stringify({
      $insert_id: "evt-1",
      event_type: "get_wallet_address",
      event_time: "2026-09-23 02:10:00.000",
    });
    const zipped = zipSync({
      "2026-09-23_2.json.gz": gzipSync(strToU8(`${line}\n`)),
    });
    const patches: unknown[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("amplitude_sync_state") && (!init?.method || init.method === "GET")) {
        return syncState("2026-09-23T02:00:00.000Z");
      }
      if (url.includes("amplitude.com")) {
        return new Response(zipped, { status: 200 });
      }
      if (url.includes("amplitude_events")) {
        return new Response(null, { status: 201 });
      }
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await syncAmplitudeExport(env, new Date("2026-09-23T06:00:00.000Z"));
    expect(result).toMatchObject({
      status: "synced",
      upserted: 1,
      endHour: "20260923T03",
    });
    expect(patches).toEqual([
      expect.objectContaining({ last_synced_at: "2026-09-23T04:00:00.000Z" }),
    ]);
  });
});
