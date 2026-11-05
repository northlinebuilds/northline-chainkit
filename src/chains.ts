// Chain registry: only free, public RPCs. No API keys.
export type ChainKey = "base" | "arc";

export interface ChainInfo {
  key: ChainKey;
  name: string;
  chainId: number;
  rpc: string;
  rpcFallbacks: string[];
  explorer: string;
  usdc: `0x${string}`; // ERC-20 USDC (6 decimals)
  nativeSymbol: string;
  nativeDecimals: number;
  nativeIsUsdc: boolean;
}

export const CHAINS: Record<ChainKey, ChainInfo> = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpc: "https://mainnet.base.org",
    rpcFallbacks: ["https://base-rpc.publicnode.com", "https://base.drpc.org"],
    explorer: "https://basescan.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
    nativeIsUsdc: false,
  },
  arc: {
    key: "arc",
    name: "Arc",
    chainId: 5042,
    rpc: "https://rpc.mainnet.arc.io",
    rpcFallbacks: ["https://rpc.quicknode.mainnet.arc.io", "https://arc.drpc.org"],
    explorer: "https://explorer.arc.io",
    // Arc's ERC-20 interface to native USDC (6 decimals); native balance itself uses 18 decimals.
    usdc: "0x3600000000000000000000000000000000000000",
    nativeSymbol: "USDC",
    nativeDecimals: 18,
    nativeIsUsdc: true,
  },
};

export function getChain(key: string | undefined | null, fallback: ChainKey = "base"): ChainInfo {
  const k = (key ?? fallback).toLowerCase();
  if (k === "base" || k === "8453" || k === "eip155:8453") return CHAINS.base;
  if (k === "arc" || k === "5042" || k === "eip155:5042") return CHAINS.arc;
  throw new InputError(`unsupported chain '${key}'. Use 'base' or 'arc'.`);
}

export class InputError extends Error {
  status = 400;
}
