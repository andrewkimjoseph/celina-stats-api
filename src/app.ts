import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { requireReadKey } from "./auth.js";
import type { StatsEnv } from "./env.js";
import {
  offchainErrorMessage,
  readOffchainDaily,
  readOffchainDevices,
  readOffchainEvents,
  readOffchainProjects,
  readOffchainSync,
  readOffchainTools,
  readOffchainWallets,
} from "./offchain.js";
import { ingestOnchainTxn, isTxHash, readOnchainTxns } from "./onchain.js";
import { readPackageStats } from "./package.js";

type AppBindings = { Bindings: StatsEnv };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function rejectIfOnchainRateLimited(
  c: Context<AppBindings>,
): Promise<Response | null> {
  const limiter = c.env?.ONCHAIN_RATE_LIMITER;
  if (!limiter) return null;
  const ip = c.req.header("CF-Connecting-IP")?.trim() || "unknown";
  const { success } = await limiter.limit({ key: ip.slice(0, 64) });
  if (!success) {
    return c.json({ error: "Too many requests" }, 429);
  }
  return null;
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

  app.use("/offchain/*", requireReadKey);
  app.use("/package", requireReadKey);
  app.use("/onchain", async (c, next) => {
    if (c.req.method === "GET") return requireReadKey(c, next);
    return next();
  });

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
    const limited = await rejectIfOnchainRateLimited(c);
    if (limited) return limited;

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

  app.get("/offchain/daily", async (c) => {
    try {
      return c.json(await readOffchainDaily(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/wallets", async (c) => {
    try {
      return c.json(await readOffchainWallets(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/tools", async (c) => {
    try {
      return c.json(await readOffchainTools(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/projects", async (c) => {
    try {
      return c.json(await readOffchainProjects(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/devices", async (c) => {
    try {
      return c.json(await readOffchainDevices(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/sync", async (c) => {
    try {
      return c.json(await readOffchainSync(c.env));
    } catch (error) {
      return c.json({ error: offchainErrorMessage(error) }, 502);
    }
  });

  app.get("/offchain/events", async (c) => {
    try {
      const { rows, lastSyncedAt } = await readOffchainEvents(c.env);
      return c.json({ rows, lastSyncedAt });
    } catch (error) {
      return c.json(
        { error: offchainErrorMessage(error), rows: [], lastSyncedAt: null },
        502,
      );
    }
  });

  app.get("/package", async (c) => {
    try {
      const stats = await readPackageStats();
      if (stats.error && stats.rows.length === 0) {
        return c.json(stats, 502);
      }
      return c.json(stats);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return c.json(
        {
          error: message,
          rows: [],
          lastSyncedAt: null,
          partial: false,
          failedPackages: [],
        },
        502,
      );
    }
  });

  return app;
}

export const app = createApp();
