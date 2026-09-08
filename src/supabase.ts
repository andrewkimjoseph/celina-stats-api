import type { StatsEnv } from "./env.js";

export function supabaseConfig(env: StatsEnv) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return { url: url.replace(/\/+$/, ""), key };
}

export async function sbFetch(
  env: StatsEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const { url, key } = supabaseConfig(env);
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}
