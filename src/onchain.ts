import { checkAttributionInCalldata } from "@andrewkimjoseph/celina-sdk";
import { DEFAULT_CELO_RPC_URL, type StatsEnv } from "./env.js";
import { sbFetch } from "./supabase.js";

export type CelinaTxRow = {
  day: string;
  hash: string;
  block_time: string;
  block_number: number;
  from: string;
  to: string;
};

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const SB_PAGE_SIZE = 1000;

type JsonRpcResult<T> = { result?: T; error?: { message?: string } };

async function celoRpc<T>(
  env: StatsEnv,
  method: string,
  params: unknown[],
): Promise<T> {
  const url = env.CELO_RPC_URL?.trim() || DEFAULT_CELO_RPC_URL;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`Celo RPC ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const json = (await res.json()) as JsonRpcResult<T>;
  if (json.error) {
    throw new Error(json.error.message ?? "Celo RPC error");
  }
  return json.result as T;
}

function hexToNumber(hex: string | null | undefined): number {
  if (!hex) return 0;
  return Number.parseInt(hex, 16);
}

function dayKeyFromBlockTime(blockTimeIso: string): string {
  const d = new Date(blockTimeIso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

export function isTxHash(hash: unknown): hash is `0x${string}` {
  return typeof hash === "string" && TX_HASH_RE.test(hash);
}

export type IngestResult =
  | { ok: true; hash: string }
  | { ok: false; status: 400 | 404 | 422 | 502; error: string };

export async function ingestOnchainTxn(
  env: StatsEnv,
  hash: `0x${string}`,
): Promise<IngestResult> {
  try {
    const tx = await celoRpc<{
      hash?: string;
      from?: string;
      to?: string | null;
      input?: string;
      blockNumber?: string | null;
    } | null>(env, "eth_getTransactionByHash", [hash]);

    if (!tx?.hash) {
      return { ok: false, status: 404, error: "Transaction not found" };
    }

    const receipt = await celoRpc<{
      status?: string;
      blockNumber?: string;
    } | null>(env, "eth_getTransactionReceipt", [hash]);

    if (!receipt) {
      return { ok: false, status: 404, error: "Receipt not found" };
    }
    if (receipt.status !== "0x1") {
      return { ok: false, status: 422, error: "Transaction was not successful" };
    }

    const input = (tx.input ?? "0x") as `0x${string}`;
    const attribution = checkAttributionInCalldata(input, "celina");
    const tagged = attribution.matched || attribution.tags.includes("celina");
    if (!tagged) {
      return {
        ok: false,
        status: 422,
        error: "Transaction is not celina-tagged",
      };
    }

    const blockNumberHex = receipt.blockNumber ?? tx.blockNumber;
    if (!blockNumberHex) {
      return { ok: false, status: 422, error: "Transaction is not mined" };
    }
    const block = await celoRpc<{ timestamp?: string } | null>(
      env,
      "eth_getBlockByNumber",
      [blockNumberHex, false],
    );
    const ts = hexToNumber(block?.timestamp);
    if (!ts) {
      return { ok: false, status: 502, error: "Block timestamp unavailable" };
    }

    const block_time = new Date(ts * 1000).toISOString();
    const day = dayKeyFromBlockTime(block_time);
    const row = {
      hash: hash.toLowerCase(),
      day,
      block_time,
      block_number: hexToNumber(blockNumberHex),
      from: (tx.from ?? "").toLowerCase(),
      to: (tx.to ?? "").toLowerCase(),
      synced_at: new Date().toISOString(),
    };

    const res = await sbFetch(env, "/rest/v1/celina_txns?on_conflict=hash", {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      return {
        ok: false,
        status: 502,
        error: `Supabase upsert ${res.status}: ${(await res.text()).slice(0, 200)}`,
      };
    }
    return { ok: true, hash: row.hash };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 502, error: message };
  }
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const slash = header.lastIndexOf("/");
  if (slash < 0) return null;
  const raw = header.slice(slash + 1).trim();
  if (raw === "*") return null;
  const total = Number(raw);
  return Number.isFinite(total) ? total : null;
}

function mapStoredRow(r: Record<string, unknown>): CelinaTxRow | null {
  const hash = String(r.hash ?? "").trim();
  const block_time = String(r.block_time ?? "").trim();
  if (!hash || !block_time) return null;
  const day =
    typeof r.day === "string" && r.day
      ? String(r.day).slice(0, 10)
      : dayKeyFromBlockTime(block_time);
  if (!day) return null;
  return {
    day,
    hash,
    block_time,
    block_number: Number(r.block_number ?? 0),
    from: String(r.from ?? ""),
    to: String(r.to ?? ""),
  };
}

export async function readOnchainTxns(env: StatsEnv): Promise<{
  rows: CelinaTxRow[];
  lastSyncedAt: string | null;
}> {
  const rows: CelinaTxRow[] = [];
  let from = 0;
  let expectedTotal: number | null = null;
  let lastSyncedAt: string | null = null;

  while (true) {
    const to = from + SB_PAGE_SIZE - 1;
    const res = await sbFetch(
      env,
      `/rest/v1/celina_txns?select=*&order=block_time.desc`,
      {
        headers: {
          Range: `${from}-${to}`,
          Prefer: "count=exact",
        },
      },
    );
    if (!res.ok && res.status !== 206) {
      throw new Error(
        `Supabase read celina_txns ${res.status}: ${(await res.text()).slice(0, 200)}`,
      );
    }
    const page = (await res.json()) as Array<Record<string, unknown>>;
    for (const r of page) {
      const mapped = mapStoredRow(r);
      if (mapped) rows.push(mapped);
      const synced = typeof r.synced_at === "string" ? r.synced_at : null;
      if (synced && (!lastSyncedAt || synced > lastSyncedAt)) {
        lastSyncedAt = synced;
      }
    }
    if (expectedTotal === null) {
      expectedTotal = parseContentRangeTotal(res.headers.get("content-range"));
    }
    if (page.length === 0) break;
    if (expectedTotal !== null && rows.length >= expectedTotal) break;
    if (page.length < SB_PAGE_SIZE) break;
    from += page.length;
  }

  return { rows, lastSyncedAt };
}
