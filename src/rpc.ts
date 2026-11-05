import { InputError, type ChainInfo } from "./chains";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RpcCall {
  method: string;
  params: unknown[];
}

export class RpcError extends Error {
  status = 502;
}

/** Errors that mean "the call itself reverted/invalid": a different RPC would answer the same, so don't retry. */
const isDeterministic = (err: { code?: number; message?: string }) =>
  err?.code === 3 || /revert|invalid opcode|out of gas|invalid argument|invalid params/i.test(String(err?.message ?? ""));

/** A lagging or pruned node answers null for a tx it hasn't seen; ask the next RPC before concluding "not found". */
const RETRY_ON_NULL = new Set(["eth_getTransactionReceipt", "eth_getTransactionByHash"]);

async function onePass(url: string, calls: RpcCall[], fetchImpl: FetchLike) {
  const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params }));
  const out: { ok: boolean; result: unknown }[] = calls.map(() => ({ ok: false, result: null }));
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    return out;
  }
  if (!res.ok) return out;
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    return out;
  }
  if (!Array.isArray(json)) return out; // whole-batch error (rate limit etc.): all retryable
  for (const item of json as { id: number; result?: unknown; error?: { code?: number; message?: string } }[]) {
    if (typeof item?.id !== "number" || item.id < 0 || item.id >= calls.length) continue;
    if (item.error) out[item.id] = { ok: isDeterministic(item.error), result: null };
    else if ((item.result ?? null) === null && RETRY_ON_NULL.has(calls[item.id].method)) out[item.id] = { ok: false, result: null };
    else out[item.id] = { ok: true, result: item.result ?? null };
  }
  return out;
}

/**
 * JSON-RPC batch with failover: calls that fail transiently (network, HTTP error, rate limit, missing reply)
 * are retried on the chain's fallback RPCs. Returns results in call order; reverted calls come back as null.
 */
export async function rpcBatch(
  chain: ChainInfo,
  calls: RpcCall[],
  fetchImpl: FetchLike = fetch,
  rpcOverride?: string,
): Promise<(unknown | null)[]> {
  const urls = rpcOverride ? [rpcOverride] : [chain.rpc, ...chain.rpcFallbacks];
  const results: (unknown | null)[] = new Array(calls.length).fill(null);
  let pending = calls.map((_, i) => i);
  for (const url of urls) {
    if (!pending.length) break;
    const pass = await onePass(url, pending.map((i) => calls[i]), fetchImpl);
    const still: number[] = [];
    pass.forEach((r, j) => {
      if (r.ok) results[pending[j]] = r.result;
      else still.push(pending[j]);
    });
    pending = still;
  }
  if (pending.length === calls.length) throw new RpcError(`${chain.name} RPCs unavailable`);
  return results;
}

export function assertAddress(a: string | undefined | null, field = "address"): `0x${string}` {
  if (!a || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new InputError(`'${field}' must be a 0x-prefixed 20-byte hex address`);
  return a.toLowerCase() as `0x${string}`;
}

export function assertTxHash(h: string | undefined | null): `0x${string}` {
  if (!h || !/^0x[0-9a-fA-F]{64}$/.test(h)) throw new InputError("'tx' must be a 0x-prefixed 32-byte transaction hash");
  return h.toLowerCase() as `0x${string}`;
}

export const hexToBigInt = (h: unknown): bigint | null =>
  typeof h === "string" && /^0x[0-9a-fA-F]*$/.test(h) ? BigInt(h === "0x" ? 0 : h) : null;

export function formatUnits(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const x = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = x / base;
  const frac = (x % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function parseUnits(s: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(s)) throw new InputError(`invalid amount '${s}'`);
  const [w, f = ""] = s.split(".");
  if (f.length > decimals) throw new InputError(`amount '${s}' has more than ${decimals} decimals`);
  return BigInt(w) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}
