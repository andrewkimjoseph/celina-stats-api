import { app } from "./app.js";
import { syncAmplitudeExport } from "./amplitude.js";
import type { StatsEnv } from "./env.js";

export default {
  fetch: (request: Request, env: StatsEnv, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
  async scheduled(
    _event: ScheduledEvent,
    env: StatsEnv,
    ctx: { waitUntil: (promise: Promise<unknown>) => void },
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          await syncAmplitudeExport(env);
          console.log("[celina-stats-api] amplitude sync complete");
        } catch (err) {
          console.error("[celina-stats-api] amplitude sync failed", err);
        }
      })(),
    );
  },
};
