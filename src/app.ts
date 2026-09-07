import { Hono } from "hono";
import { cors } from "hono/cors";
import { readOffchainStats } from "./amplitude.js";
import type { StatsEnv } from "./env.js";
import { ingestOnchainTxn, isTxHash, readOnchainTxns } from "./onchain.js";

type AppBindings = { Bindings: StatsEnv };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createApp(): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  app.get("/", (c) =>
    c.json({
      ok: true,
      service: "celina-stats-api",
    }),
  );

  app.get("/health", (c) =>
    c.json({
      ok: true,
      service: "celina-stats-api",
    }),
  );

  app.post("/onchain", async (c) => {
    let body: unknown = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!isRecord(body) || !isTxHash(body.hash)) {
      return c.json({ error: "hash must be a 32-byte 0x-prefixed hex string" }, 400);
    }

    const result = await ingestOnchainTxn(c.env, body.hash);
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json({ ok: true, hash: result.hash });
  });

  app.get("/onchain", async (c) => {
    try {
      const { rows, lastSyncedAt } = await readOnchainTxns(c.env);
      return c.json({ rows, lastSyncedAt });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json({ error: message, rows: [], lastSyncedAt: null }, 502);
    }
  });

  app.get("/offchain", async (c) => {
    try {
      const stats = await readOffchainStats(c.env);
      return c.json(stats);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json(
        {
          error: message,
          daily: [],
          dailyWalletsQueried: [],
          perTool: [],
          total: 0,
          uniqueDevices: 0,
          walletsQueried: 0,
          lastSyncedAt: null,
        },
        502,
      );
    }
  });

  return app;
}

export const app = createApp();
