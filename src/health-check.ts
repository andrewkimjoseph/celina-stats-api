export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

export async function checkUrl(
  url: string,
  init: RequestInit = {},
  timeoutMs = HEALTH_CHECK_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
