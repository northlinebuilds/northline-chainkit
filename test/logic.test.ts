import { describe, it, expect } from "vitest";
import { CHAINS } from "../src/chains";
import { addressProfile, verifyPayment, explainTx, networkStatus, usdcBalances, decodeString, SLOTS, TRANSFER_TOPIC, ARC_NATIVE_LOG_EMITTER } from "../src/logic";
import { formatUnits, parseUnits } from "../src/rpc";
import { makeFetch, abiString, word } from "./mocks";

const TOKEN = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const IMPL = "0x2ce6311ddae708829bc0784c967b7d77d19fd779";
const ME = "0xfe5d81d8268cbac025829cedd11d5cf6962d4096";
const TX = "0x" + "ab".repeat(32);

describe("units", () => {
  it("formats and parses", () => {
    expect(formatUnits(1234500n, 6)).toBe("1.2345");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(parseUnits("0.01", 6)).toBe(10000n);
    expect(() => parseUnits("1.0000001", 6)).toThrow();
    expect(() => parseUnits("abc", 6)).toThrow();
  });
  it("decodes abi strings and bytes32 strings", () => {
    expect(decodeString(abiString("USD Coin"))).toBe("USD Coin");
    expect(decodeString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"))).toBe("MKR");
    expect(decodeString("0x")).toBeNull();
  });
});

describe("addressProfile", () => {
  it("profiles an upgradeable ERC-20 proxy", async () => {
    const { fetch } = makeFetch(
      (m, p) => {
        if (m === "eth_getCode") return "0x" + "60".repeat(1800);
        if (m === "eth_getBalance") return "0x0";
        if (m === "eth_getTransactionCount") return "0x1";
        if (m === "eth_getStorageAt") return p[1] === SLOTS.eip1967Impl ? word(IMPL) : word("0");
        if (m === "eth_call") {
          const d = p[0].data as string;
          if (d.startsWith("0x70a08231")) return word("0");
          if (d === "0x06fdde03") return abiString("USD Coin");
          if (d === "0x95d89b41") return abiString("USDC");
          if (d === "0x313ce567") return word("6");
          if (d === "0x18160ddd") return word((5_000_000n * 10n ** 6n).toString(16));
          return undefined; // owner(), getThreshold() revert
        }
      },
      { [TOKEN]: "exact_match" },
    );
    const r = await addressProfile({ fetch }, CHAINS.base, TOKEN);
    expect(r.kind).toBe("contract");
    expect(r.proxy?.eip1967Implementation).toBe(IMPL);
    expect(r.token).toMatchObject({ symbol: "USDC", decimals: 6, name: "USD Coin", totalSupply: "5000000" });
    expect(r.sourcify).toBe("exact_match");
    expect(r.flags).toContain("upgradeable_proxy");
    expect(r.flags).not.toContain("source_not_verified_on_sourcify");
    expect(r.owner).toBeNull();
  });

  it("detects legacy zos proxies like Circle's USDC", async () => {
    const { fetch } = makeFetch((m, p) => {
      if (m === "eth_getCode") return "0x" + "60".repeat(100);
      if (m === "eth_getStorageAt") return p[1] === SLOTS.zosImpl ? word(IMPL) : word("0");
      if (m === "eth_call") return undefined;
      return "0x0";
    });
    const r = await addressProfile({ fetch }, CHAINS.base, TOKEN);
    expect(r.proxy?.legacyZosImplementation).toBe(IMPL);
    expect(r.flags).toContain("upgradeable_proxy");
  });

  it("detects an EIP-7702 delegated EOA and never calls sourcify", async () => {
    const { fetch, calls } = makeFetch((m) => {
      if (m === "eth_getCode") return "0xef0100" + "12".repeat(20);
      if (m === "eth_getBalance") return "0xde0b6b3a7640000";
      if (m === "eth_getTransactionCount") return "0x5";
      if (m === "eth_call") return "0x";
      if (m === "eth_getStorageAt") return word("0");
    });
    const r = await addressProfile({ fetch }, CHAINS.base, ME);
    expect(r.kind).toBe("eoa_7702_delegated");
    expect(r.delegatedTo).toBe("0x" + "12".repeat(20));
    expect(r.flags).toContain("eoa_delegates_code_via_eip7702");
    expect(r.nativeBalance.amount).toBe("1");
    expect(calls.some((c) => c.url.includes("sourcify"))).toBe(false);
  });

  it("flags a fresh empty EOA and unverified contracts", async () => {
    const { fetch } = makeFetch((m) => (m === "eth_getCode" ? "0x" : m === "eth_call" ? "0x" : "0x0"));
    const r = await addressProfile({ fetch }, CHAINS.arc, ME);
    expect(r.kind).toBe("eoa");
    expect(r.flags).toEqual(["fresh_empty_address"]);
    expect(r.nativeBalance.symbol).toBe("USDC");
  });

  it("rejects bad input", async () => {
    const { fetch } = makeFetch(() => "0x");
    await expect(addressProfile({ fetch }, CHAINS.base, "0x123")).rejects.toThrow(/address/);
  });
});

const log = (address: string, from: string, to: string, amount: bigint, i = 0) => ({
  address,
  topics: [TRANSFER_TOPIC, word(from), word(to)],
  data: word(amount.toString(16)),
  logIndex: "0x" + i.toString(16),
});

describe("verifyPayment", () => {
  const mk = (logs: any[], status = "0x1", block = "0x64", head = "0x70") =>
    makeFetch((m) => {
      if (m === "eth_getTransactionReceipt") return { status, blockNumber: block, logs };
      if (m === "eth_blockNumber") return head;
    }).fetch;

  it("verifies a Base USDC payment", async () => {
    const fetch = mk([log(CHAINS.base.usdc, "0x" + "11".repeat(20), ME, 50_000n)]);
    const r: any = await verifyPayment({ fetch }, CHAINS.base, { tx: TX, to: ME, minAmount: "0.05" });
    expect(r.verified).toBe(true);
    expect(r.receivedUsdc).toBe("0.05");
    expect(r.confirmations).toBe(13);
  });

  it("fails when amount is short, tx reverted, or wrong recipient", async () => {
    let r: any = await verifyPayment({ fetch: mk([log(CHAINS.base.usdc, "0x" + "11".repeat(20), ME, 40_000n)]) }, CHAINS.base, { tx: TX, to: ME, minAmount: "0.05" });
    expect(r.verified).toBe(false);
    r = await verifyPayment({ fetch: mk([log(CHAINS.base.usdc, "0x" + "11".repeat(20), ME, 50_000n)], "0x0") }, CHAINS.base, { tx: TX, to: ME });
    expect(r.reasons).toContain("tx_reverted");
    r = await verifyPayment({ fetch: mk([log(CHAINS.base.usdc, "0x" + "11".repeat(20), "0x" + "22".repeat(20), 50_000n)]) }, CHAINS.base, { tx: TX, to: ME });
    expect(r.verified).toBe(false);
    // a fake token that emits Transfer must not count
    r = await verifyPayment({ fetch: mk([log("0x" + "99".repeat(20), "0x" + "11".repeat(20), ME, 10n ** 12n)]) }, CHAINS.base, { tx: TX, to: ME, minAmount: "1" });
    expect(r.verified).toBe(false);
  });

  it("handles Arc native-USDC logs (18 decimals) without double counting", async () => {
    const native = log(ARC_NATIVE_LOG_EMITTER, ME, "0xf6103b23fd7d528abd3fbcb25935a41fb731e5ba", 10n ** 16n);
    const erc = log(CHAINS.arc.usdc, ME, "0xf6103b23fd7d528abd3fbcb25935a41fb731e5ba", 10_000n, 1);
    const r: any = await verifyPayment({ fetch: mk([native, erc]) }, CHAINS.arc, { tx: TX, to: "0xf6103b23fd7d528abd3fbcb25935a41fb731e5ba", minAmount: "0.01" });
    expect(r.verified).toBe(true);
    expect(r.receivedUsdc).toBe("0.01");
    expect(r.transfers).toHaveLength(2);
  });

  it("reports missing receipts and enforces confirmations", async () => {
    const none = makeFetch((m) => (m === "eth_blockNumber" ? "0x1" : null)).fetch;
    expect((await verifyPayment({ fetch: none }, CHAINS.base, { tx: TX, to: ME })).found).toBe(false);
    const r: any = await verifyPayment({ fetch: mk([log(CHAINS.base.usdc, "0x" + "11".repeat(20), ME, 1n)], "0x1", "0x70", "0x70") }, CHAINS.base, { tx: TX, to: ME, minConfirmations: "5" });
    expect(r.reasons).toContain("not_enough_confirmations");
  });
});

describe("explainTx / network / balances", () => {
  it("decodes token transfers with symbols", async () => {
    const { fetch } = makeFetch((m, p) => {
      if (m === "eth_getTransactionByHash") return { from: ME, to: CHAINS.base.usdc, value: "0x0", input: "0xa9059cbb" + "00".repeat(64), nonce: "0x1" };
      if (m === "eth_getTransactionReceipt") return { status: "0x1", gasUsed: "0xea60", effectiveGasPrice: "0x3b9aca00", blockNumber: "0x10", logs: [log(CHAINS.base.usdc, ME, "0x" + "22".repeat(20), 5_000_000n)] };
      if (m === "eth_blockNumber") return "0x10";
      if (m === "eth_call") return p[0].data === "0x95d89b41" ? abiString("USDC") : word("6");
    });
    const r: any = await explainTx({ fetch }, CHAINS.base, TX);
    expect(r.status).toBe("success");
    expect(r.methodSelector).toBe("0xa9059cbb");
    expect(r.tokenTransfers[0]).toMatchObject({ symbol: "USDC", amount: "5" });
    expect(r.fee.amount).toBe("0.00006");
  });

  it("quotes Arc fees in USDC", async () => {
    const { fetch } = makeFetch((m) => ({ eth_blockNumber: "0x100", eth_gasPrice: "0x4a817c800", eth_chainId: "0x13b2" } as any)[m]);
    const r = await networkStatus({ fetch }, CHAINS.arc);
    expect(r.chainId).toBe(5042);
    expect(r.gasPriceGwei).toBe("20");
    expect(r.feeEstimates.unit).toBe("USDC");
    expect(r.feeEstimates.nativeTransfer21k).toBe("0.00042");
  });

  it("returns balances on both chains", async () => {
    const { fetch } = makeFetch((m) => (m === "eth_getBalance" ? "0x0" : word((8_290_000n).toString(16))));
    const r = await usdcBalances({ fetch }, [CHAINS.base, CHAINS.arc], ME);
    expect(r.balances.map((b) => b.usdc)).toEqual(["8.29", "8.29"]);
  });
});

describe("rpc failover", () => {
  it("retries rate-limited calls on the fallback RPC, but not reverts", async () => {
    const { rpcBatch } = await import("../src/rpc");
    const hits: string[] = [];
    const f = async (url: string, init?: RequestInit) => {
      hits.push(url);
      const body = JSON.parse(String(init!.body));
      if (url === CHAINS.base.rpc)
        return new Response(JSON.stringify(body.map((c: any) => (c.method === "eth_call" ? { id: c.id, error: { code: 3, message: "execution reverted" } } : { id: c.id, error: { code: -32016, message: "over rate limit" } }))));
      return new Response(JSON.stringify(body.map((c: any) => ({ id: c.id, result: "0x1" }))));
    };
    const r = await rpcBatch(CHAINS.base, [{ method: "eth_call", params: [] }, { method: "eth_getBalance", params: [] }], f);
    expect(r).toEqual([null, "0x1"]);
    expect(hits).toEqual([CHAINS.base.rpc, CHAINS.base.rpcFallbacks[0]]);
  });
  it("fails over when the primary returns a non-batch error object", async () => {
    const { rpcBatch } = await import("../src/rpc");
    const f = async (url: string, init?: RequestInit) =>
      url === CHAINS.arc.rpc ? new Response(JSON.stringify({ error: "rate limited" }), { status: 200 }) : new Response(JSON.stringify(JSON.parse(String(init!.body)).map((c: any) => ({ id: c.id, result: { status: "0x1" } }))));
    expect(await rpcBatch(CHAINS.arc, [{ method: "eth_getTransactionReceipt", params: [] }], f)).toEqual([{ status: "0x1" }]);
  });
  it("throws when every RPC is down", async () => {
    const { rpcBatch } = await import("../src/rpc");
    await expect(rpcBatch(CHAINS.base, [{ method: "eth_blockNumber", params: [] }], async () => new Response("no", { status: 503 }))).rejects.toThrow(/unavailable/);
  });
});
