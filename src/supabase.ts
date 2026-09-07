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

export async function sbRpcScalar(
  env: StatsEnv,
  name: string,
  body: Record<string, unknown>,
): Promise<number> {
  const res = await sbFetch(env, `/rest/v1/rpc/${name}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `Supabase rpc ${name} ${res.status}: ${(await res.text()).slice(0, 200)}`,
    );
  }
  const value = await res.json();
  return Number(value ?? 0);
}
