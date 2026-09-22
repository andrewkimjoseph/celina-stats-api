import type { Context, Next } from "hono";
import type { StatsEnv } from "./env.js";

type AuthContext = Context<{ Bindings: StatsEnv }>;

/** Compare two strings without leaking the secret through an early exit. */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function bearerToken(header: string | undefined): string {
  if (!header) return "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? "";
}

/** Fail closed when `STATS_READ_KEY` is missing or the bearer token does not match. */
export async function requireReadKey(c: AuthContext, next: Next): Promise<Response | void> {
  const expected = c.env?.STATS_READ_KEY?.trim() ?? "";
  const token = bearerToken(c.req.header("Authorization"));
  if (!expected || !timingSafeEqual(token, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
}
