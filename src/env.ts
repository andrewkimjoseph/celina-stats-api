export type RateLimiter = {
  limit(options: { key: string }): Promise<{ success: boolean }>;
};

export type StatsEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CELO_RPC_URL?: string;
  AMPLITUDE_API_KEY?: string;
  AMPLITUDE_SECRET_KEY?: string;
  AMPLITUDE_REGION?: string;
  /** Bearer token required for dashboard reads. Unset fails closed. */
  STATS_READ_KEY?: string;
  /** Workers Rate Limiting binding for `POST /onchain`. Absent in unit tests. */
  ONCHAIN_RATE_LIMITER?: RateLimiter;
  /** Workers Rate Limiting binding for `POST /telemetry`. Absent in unit tests. */
  TELEMETRY_RATE_LIMITER?: RateLimiter;
};

export const DEFAULT_PRODUCTION_BASE_URL = "https://api.stats.usecelina.xyz";
export const DEFAULT_CELO_RPC_URL = "https://forno.celo.org";
