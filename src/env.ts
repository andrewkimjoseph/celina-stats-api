export type StatsEnv = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  CELO_RPC_URL?: string;
  AMPLITUDE_API_KEY?: string;
  AMPLITUDE_SECRET_KEY?: string;
  AMPLITUDE_REGION?: string;
};

export const DEFAULT_PRODUCTION_BASE_URL = "https://api.stats.usecelina.xyz";
export const DEFAULT_CELO_RPC_URL = "https://forno.celo.org";
