import { type ChainInfo, InputError } from "./chains";
import { type FetchLike, rpcBatch, hexToBigInt, formatUnits, parseUnits, assertAddress, assertTxHash } from "./rpc";

export interface Deps {
  fetch: FetchLike;
  rpcOverride?: Partial<Record<string, string>>;
  sourcifyBase?: string;
  now?: () => number;
}

const SEL = {
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
  owner: "0x8da5cb5b",
  getThreshold: "0xe75235b8", // Safe multisig
  balanceOf: "0x70a08231",
};
export const SLOTS = {
  eip1967Impl: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  eip1967Admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  eip1967Beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  // Legacy OpenZeppelin (zos) AdminUpgradeabilityProxy, used by Circle's FiatTokenProxy (USDC).
  zosImpl: "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3",
  zosAdmin: "0x10d6a54a4754c8869d6886b5f5d7fbfa5b4522237ea5c60d11bc4e7a1ff9390b",
};
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Arc emits ERC-20-style Transfer logs for native USDC moves from this system address (18 decimals). */
export const ARC_NATIVE_LOG_EMITTER = "0xfffffffffffffffffffffffffffffffffffffffe";
const ZERO32 = "0x" + "0".repeat(64);

const pad32 = (addr: string) => "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const wordToAddress = (w: unknown): string | null => {
  if (typeof w !== "string" || w.length < 42 || w === "0x" || /^0x0*$/.test(w)) return null;
  return "0x" + w.slice(-40).toLowerCase();
};
const rpcFor = (deps: Deps, chain: ChainInfo) => deps.rpcOverride?.[chain.key];

/** Decode an ABI `string` return, or a bytes32 string (old tokens like MKR). */
export function decodeString(hex: unknown): string | null {
  if (typeof hex !== "string" || hex.length < 66) return null;
  const data = hex.slice(2);
  try {
    if (data.length >= 128) {
      const off = Number(BigInt("0x" + data.slice(0, 64)));
      const len = Number(BigInt("0x" + data.slice(off * 2, off * 2 + 64)));
      if (off === 32 && len <= 256 && data.length >= (off + 32 + len) * 2) {
        const bytes = data.slice((off + 32) * 2, (off + 32 + len) * 2);
        return utf8(bytes);
      }
    }
    const s = utf8(data.slice(0, 64)).replace(/\u0000+$/g, "");
    return s.length ? s : null;
  } catch {
    return null;
  }
}
function utf8(hexBytes: string): string {
  const arr = new Uint8Array(hexBytes.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hexBytes.substr(i * 2, 2), 16);
  return new TextDecoder().decode(arr).replace(/[\u0000-\u001f]/g, "");
}

async function sourcifyStatus(deps: Deps, chain: ChainInfo, address: string): Promise<string | null> {
  const base = deps.sourcifyBase ?? "https://sourcify.dev/server";
  try {
    const r = await deps.fetch(`${base}/v2/contract/${chain.chainId}/${address}`, { method: "GET" });
    if (!r.ok) return null;
    const j = (await r.json()) as { match?: string | null };
    return j.match ?? "not_verified";
  } catch {
    return null; // best effort only
  }
}

// ---------------------------------------------------------------- address preflight
export async function addressProfile(deps: Deps, chain: ChainInfo, rawAddress: string) {
  const address = assertAddress(rawAddress);
  const call = (data: string) => ({ method: "eth_call", params: [{ to: address, data }, "latest"] });
  const [code, nativeBal, nonce, usdcBal, implSlot, adminSlot, beaconSlot, name, symbol, decimals, supply, owner, threshold, zosImpl, zosAdmin] =
    await rpcBatch(
      chain,
      [
        { method: "eth_getCode", params: [address, "latest"] },
        { method: "eth_getBalance", params: [address, "latest"] },
        { method: "eth_getTransactionCount", params: [address, "latest"] },
        { method: "eth_call", params: [{ to: chain.usdc, data: SEL.balanceOf + pad32(address).slice(2) }, "latest"] },
        { method: "eth_getStorageAt", params: [address, SLOTS.eip1967Impl, "latest"] },
        { method: "eth_getStorageAt", params: [address, SLOTS.eip1967Admin, "latest"] },
        { method: "eth_getStorageAt", params: [address, SLOTS.eip1967Beacon, "latest"] },
        call(SEL.name),
        call(SEL.symbol),
        call(SEL.decimals),
        call(SEL.totalSupply),
        call(SEL.owner),
        call(SEL.getThreshold),
        { method: "eth_getStorageAt", params: [address, SLOTS.zosImpl, "latest"] },
        { method: "eth_getStorageAt", params: [address, SLOTS.zosAdmin, "latest"] },
      ],
      deps.fetch,
      rpcFor(deps, chain),
    );
  if (code === null && nativeBal === null) throw new InputError("RPC returned no data for this address");
  const codeHex = typeof code === "string" ? code : "0x";
  const codeBytes = (codeHex.length - 2) / 2;
  const delegated7702 = codeBytes === 23 && codeHex.toLowerCase().startsWith("0xef0100");
  const isContract = codeBytes > 0 && !delegated7702;
  const kind = delegated7702 ? "eoa_7702_delegated" : isContract ? "contract" : "eoa";

  const impl = isContract ? wordToAddress(implSlot) : null;
  const admin = isContract ? wordToAddress(adminSlot) : null;
  const beacon = isContract ? wordToAddress(beaconSlot) : null;
  const legacyImpl = isContract ? wordToAddress(zosImpl) : null;
  const legacyAdmin = isContract ? wordToAddress(zosAdmin) : null;
  const dec = hexToBigInt(decimals);
  const tokenDecimals = isContract && dec !== null && dec <= 36n && typeof decimals === "string" && decimals.length === 66 ? Number(dec) : null;
  const tokenSymbol = isContract ? decodeString(symbol) : null;
  const isToken = tokenDecimals !== null && tokenSymbol !== null;
  const sup = hexToBigInt(supply);
  const ownerAddr = isContract ? wordToAddress(owner) : null;
  const safeThreshold = isContract && typeof threshold === "string" && threshold.length === 66 ? Number(hexToBigInt(threshold)) : null;
  const verification = isContract ? await sourcifyStatus(deps, chain, address) : null;

  const nb = hexToBigInt(nativeBal) ?? 0n;
  const ub = hexToBigInt(usdcBal);
  const flags: string[] = [];
  if (delegated7702) flags.push("eoa_delegates_code_via_eip7702");
  if (impl || beacon || legacyImpl) flags.push("upgradeable_proxy");
  if (ownerAddr) flags.push("has_owner");
  if (isContract && verification && verification !== "exact_match" && verification !== "match") flags.push("source_not_verified_on_sourcify");
  if (kind === "eoa" && (hexToBigInt(nonce) ?? 0n) === 0n && nb === 0n) flags.push("fresh_empty_address");

  return {
    chain: chain.key,
    chainId: chain.chainId,
    address,
    kind,
    codeSizeBytes: codeBytes,
    delegatedTo: delegated7702 ? "0x" + codeHex.slice(8, 48) : null,
    nonce: hexToBigInt(nonce)?.toString() ?? null,
    nativeBalance: { symbol: chain.nativeSymbol, amount: formatUnits(nb, chain.nativeDecimals) },
    usdcBalance: ub === null ? null : formatUnits(ub, 6),
    proxy: isContract
      ? { eip1967Implementation: impl, eip1967Admin: admin, eip1967Beacon: beacon, legacyZosImplementation: legacyImpl, legacyZosAdmin: legacyAdmin }
      : null,
    token: isToken
      ? { name: decodeString(name), symbol: tokenSymbol, decimals: tokenDecimals, totalSupply: sup === null ? null : formatUnits(sup, tokenDecimals!) }
      : null,
    owner: ownerAddr,
    safeMultisigThreshold: safeThreshold && safeThreshold > 0 && safeThreshold < 100 ? safeThreshold : null,
    sourcify: verification,
    flags,
    explorer: `${chain.explorer}/address/${address}`,
    note: "Read-only facts from public RPC + Sourcify. Not financial or security advice; flags are heuristics.",
  };
}

// ---------------------------------------------------------------- payment verification
export interface TransferHit { token: string; from: string; to: string; amount: string; decimals: number; logIndex: number }

export async function verifyPayment(
  deps: Deps,
  chain: ChainInfo,
  q: { tx: string; to: string; minAmount?: string; from?: string; minConfirmations?: string },
) {
  const tx = assertTxHash(q.tx);
  const to = assertAddress(q.to, "to");
  const from = q.from ? assertAddress(q.from, "from") : null;
  const min = q.minAmount ? parseUnits(q.minAmount, 6) : 0n;
  const minConf = q.minConfirmations ? Number(q.minConfirmations) : 1;
  if (!Number.isInteger(minConf) || minConf < 0 || minConf > 1000) throw new InputError("'minConfirmations' must be 0..1000");

  const [receipt, head] = await rpcBatch(
    chain,
    [
      { method: "eth_getTransactionReceipt", params: [tx] },
      { method: "eth_blockNumber", params: [] },
    ],
    deps.fetch,
    rpcFor(deps, chain),
  );
  if (!receipt) {
    return { chain: chain.key, tx, found: false, verified: false, reason: "receipt_not_found (pending, dropped, or wrong chain)" };
  }
  const r = receipt as { status: string; blockNumber: string; logs: { address: string; topics: string[]; data: string; logIndex: string }[] };
  const success = r.status === "0x1";
  const block = hexToBigInt(r.blockNumber) ?? 0n;
  const confirmations = Number((hexToBigInt(head) ?? block) - block + 1n);

  const usdc = chain.usdc.toLowerCase();
  const hits: TransferHit[] = [];
  let erc20Sum = 0n;
  let nativeSum18 = 0n;
  for (const l of r.logs ?? []) {
    if (!l.topics || l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    const emitter = l.address.toLowerCase();
    const isUsdc = emitter === usdc;
    const isArcNative = chain.nativeIsUsdc && emitter === ARC_NATIVE_LOG_EMITTER;
    if (!isUsdc && !isArcNative) continue;
    const lf = wordToAddress(l.topics[1]) ?? "0x0000000000000000000000000000000000000000";
    const lt = wordToAddress(l.topics[2]);
    if (lt !== to) continue;
    if (from && lf !== from) continue;
    const amt = hexToBigInt(l.data) ?? 0n;
    const decimals = isUsdc ? 6 : 18;
    hits.push({ token: isUsdc ? "USDC" : "USDC(native)", from: lf, to: lt, amount: formatUnits(amt, decimals), decimals, logIndex: Number(hexToBigInt(l.logIndex) ?? 0n) });
    if (isUsdc) erc20Sum += amt;
    else nativeSum18 += amt;
  }
  // Conservative: on Arc the same move may surface via both emitters, so take the larger of the two, never the sum.
  const nativeAs6 = nativeSum18 / 10n ** 12n;
  const received6 = erc20Sum > nativeAs6 ? erc20Sum : nativeAs6;
  const reasons: string[] = [];
  if (!success) reasons.push("tx_reverted");
  if (received6 < min || hits.length === 0) reasons.push("amount_below_minimum_or_no_matching_transfer");
  if (confirmations < minConf) reasons.push("not_enough_confirmations");
  return {
    chain: chain.key,
    tx,
    found: true,
    success,
    blockNumber: block.toString(),
    confirmations,
    to,
    from,
    receivedUsdc: formatUnits(received6, 6),
    minAmount: formatUnits(min, 6),
    transfers: hits,
    verified: reasons.length === 0,
    reasons,
    explorer: `${chain.explorer}/tx/${tx}`,
  };
}

// ---------------------------------------------------------------- tx explain
export async function explainTx(deps: Deps, chain: ChainInfo, rawTx: string) {
  const tx = assertTxHash(rawTx);
  const [receipt, txo, head] = await rpcBatch(
    chain,
    [
      { method: "eth_getTransactionReceipt", params: [tx] },
      { method: "eth_getTransactionByHash", params: [tx] },
      { method: "eth_blockNumber", params: [] },
    ],
    deps.fetch,
    rpcFor(deps, chain),
  );
  if (!txo) return { chain: chain.key, tx, found: false };
  const t = txo as { from: string; to: string | null; value: string; input: string; nonce: string; type?: string };
  const r = receipt as null | { status: string; gasUsed: string; effectiveGasPrice?: string; blockNumber: string; contractAddress?: string | null; logs: { address: string; topics: string[]; data: string }[] };
  const gasUsed = hexToBigInt(r?.gasUsed) ?? 0n;
  const price = hexToBigInt(r?.effectiveGasPrice) ?? 0n;
  const fee = gasUsed * price;

  // Collect ERC-20 transfers and look up token symbol/decimals in one extra batch.
  const transfers = (r?.logs ?? []).filter((l) => l.topics?.[0]?.toLowerCase() === TRANSFER_TOPIC && l.topics.length === 3);
  const tokens = [...new Set(transfers.map((l) => l.address.toLowerCase()))].slice(0, 10);
  const meta: Record<string, { symbol: string | null; decimals: number | null }> = {};
  if (tokens.length) {
    const res = await rpcBatch(
      chain,
      tokens.flatMap((a) => [
        { method: "eth_call", params: [{ to: a, data: SEL.symbol }, "latest"] },
        { method: "eth_call", params: [{ to: a, data: SEL.decimals }, "latest"] },
      ]),
      deps.fetch,
      rpcFor(deps, chain),
    );
    tokens.forEach((a, i) => {
      const d = hexToBigInt(res[i * 2 + 1]);
      meta[a] = { symbol: decodeString(res[i * 2]), decimals: d !== null && d <= 36n ? Number(d) : null };
    });
    if (chain.nativeIsUsdc) meta[ARC_NATIVE_LOG_EMITTER] = { symbol: "USDC(native)", decimals: 18 };
  }
  const block = hexToBigInt(r?.blockNumber);
  return {
    chain: chain.key,
    tx,
    found: true,
    status: r ? (r.status === "0x1" ? "success" : "reverted") : "pending",
    blockNumber: block?.toString() ?? null,
    confirmations: block !== null && block !== undefined ? Number((hexToBigInt(head) ?? block) - block + 1n) : 0,
    from: t.from?.toLowerCase(),
    to: t.to?.toLowerCase() ?? null,
    contractCreated: r?.contractAddress ?? null,
    methodSelector: t.input && t.input.length >= 10 ? t.input.slice(0, 10) : null,
    value: { symbol: chain.nativeSymbol, amount: formatUnits(hexToBigInt(t.value) ?? 0n, chain.nativeDecimals) },
    fee: { symbol: chain.nativeSymbol, amount: formatUnits(fee, chain.nativeDecimals), gasUsed: gasUsed.toString() },
    tokenTransfers: transfers.slice(0, 50).map((l) => {
      const a = l.address.toLowerCase();
      const m = meta[a] ?? { symbol: null, decimals: null };
      const raw = hexToBigInt(l.data) ?? 0n;
      return {
        token: a,
        symbol: m.symbol,
        from: wordToAddress(l.topics[1]) ?? "0x0000000000000000000000000000000000000000",
        to: wordToAddress(l.topics[2]) ?? "0x0000000000000000000000000000000000000000",
        amount: m.decimals === null ? raw.toString() : formatUnits(raw, m.decimals),
        rawAmount: m.decimals === null,
      };
    }),
    logCount: r?.logs?.length ?? 0,
    explorer: `${chain.explorer}/tx/${tx}`,
  };
}

// ---------------------------------------------------------------- network status / fee quote
export async function networkStatus(deps: Deps, chain: ChainInfo) {
  const [block, gasPrice, cid] = await rpcBatch(
    chain,
    [
      { method: "eth_blockNumber", params: [] },
      { method: "eth_gasPrice", params: [] },
      { method: "eth_chainId", params: [] },
    ],
    deps.fetch,
    rpcFor(deps, chain),
  );
  const gp = hexToBigInt(gasPrice) ?? 0n;
  const est = (gas: bigint) => formatUnits(gas * gp, chain.nativeDecimals);
  return {
    chain: chain.key,
    chainId: Number(hexToBigInt(cid) ?? BigInt(chain.chainId)),
    blockNumber: hexToBigInt(block)?.toString() ?? null,
    gasPriceGwei: formatUnits(gp, 9),
    feeEstimates: {
      unit: chain.nativeSymbol,
      nativeTransfer21k: est(21_000n),
      erc20Transfer65k: est(65_000n),
      contractCall200k: est(200_000n),
    },
    note: chain.nativeIsUsdc
      ? "Arc charges gas in USDC, so these estimates are dollar costs."
      : "Base charges gas in ETH; L1 data fee not included.",
  };
}

// ---------------------------------------------------------------- multi-chain USDC balance
export async function usdcBalances(deps: Deps, chains: ChainInfo[], rawAddress: string) {
  const address = assertAddress(rawAddress);
  const results = await Promise.all(
    chains.map(async (chain) => {
      const [native, erc] = await rpcBatch(
        chain,
        [
          { method: "eth_getBalance", params: [address, "latest"] },
          { method: "eth_call", params: [{ to: chain.usdc, data: SEL.balanceOf + pad32(address).slice(2) }, "latest"] },
        ],
        deps.fetch,
        rpcFor(deps, chain),
      ).catch(() => [null, null]);
      const e = hexToBigInt(erc);
      return {
        chain: chain.key,
        usdc: e === null ? null : formatUnits(e, 6),
        native: { symbol: chain.nativeSymbol, amount: native === null ? null : formatUnits(hexToBigInt(native) ?? 0n, chain.nativeDecimals) },
      };
    }),
  );
  return { address, balances: results, note: "On Arc, native balance and USDC are the same funds (18 vs 6 decimals)." };
}
export { ZERO32 };
