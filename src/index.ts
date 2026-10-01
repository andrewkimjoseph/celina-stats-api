import { app } from "./app.js";
import { syncAmplitudeExport } from "./amplitude.js";
import type { StatsEnv } from "./env.js";
import { recordDailyUptime } from "./uptime.js";

/** Midnight export. The hourly cron also matches midnight, as its own invocation. */
const DAILY_CRON = "0 0 * * *";

export default {
  fetch: (request: Request, env: StatsEnv, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  async scheduled(
    event: ScheduledEvent,
    env: StatsEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ) {
    if (event.cron === DAILY_CRON) {
      ctx.waitUntil(
        (async () => {
          try {
            const result = await syncAmplitudeExport(env);
            console.log("[celina-stats-api] amplitude sync", JSON.stringify(result));
          } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            const stack = err instanceof Error ? err.stack : "";
            console.error(`[celina-stats-api] amplitude sync failed: ${detail}`, stack);
          }
        })(),
      );
      return;
    }

    ctx.waitUntil(
      (async () => {
        try {
          const results = await recordDailyUptime(env);
          console.log(
            "[celina-stats-api] uptime recorded",
            results.map((row) => `${row.id}:${row.status}`).join(","),
          );
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : "";
          console.error(`[celina-stats-api] uptime record failed: ${detail}`, stack);
        }
      })(),
    );
  },
};
