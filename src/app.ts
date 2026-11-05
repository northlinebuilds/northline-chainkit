import { Hono, type Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { CHAINS, getChain, InputError } from "./chains";
import { RpcError, assertAddress, assertTxHash, parseUnits, type FetchLike } from "./rpc";
import { addressProfile, explainTx, networkStatus, usdcBalances, verifyPayment, type Deps } from "./logic";

export interface Env {
  PAY_TO: string; // receiving wallet on Base
  NETWORK?: string; // CAIP-2, default eip155:8453 (Base mainnet)
  FACILITATOR?: string; // "cdp" | "payai" | "dexter" | full URL
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  PUBLIC_BASE_URL?: string; // e.g. https://chainkit.<sub>.workers.dev
  SERVICE_NAME?: string;
}

export const FACILITATOR_URLS: Record<string, string> = {
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402",
  payai: "https://facilitator.payai.network",
  dexter: "https://x402.dexter.cash",
  testnet: "https://x402.org/facilitator",
};

export const UNCLAIMED_URL = "https://northline-unclaimed.northline-c86.workers.dev";

const addr = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
const hash = { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" };
const chainParam = { type: "string", enum: ["base", "arc"], default: "base" };

/** Single source of truth for paid routes: price, docs, Bazaar metadata. */
export const PAID_ROUTES = [
  {
    key: "GET /v1/address/profile",
    path: "/v1/address/profile",
    price: "$0.005",
    tags: ["security", "preflight", "onchain", "base", "arc"],
    description:
      "Preflight any address on Base or Arc before paying or approving it: EOA vs contract vs EIP-7702-delegated wallet, EIP-1967 proxy implementation/admin, owner(), Safe multisig threshold, ERC-20 metadata, USDC + native balance, Sourcify verification, and risk flags.",
    input: { chain: "base", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
    inputSchema: { properties: { chain: chainParam, address: addr }, required: ["address"] },
    example: { chain: "base", kind: "contract", proxy: { eip1967Implementation: "0x2ce6311ddae708829bc0784c967b7d77d19fd779" }, token: { symbol: "USDC", decimals: 6 }, flags: ["upgradeable_proxy"] },
  },
  {
    key: "GET /v1/payment/verify",
    path: "/v1/payment/verify",
    price: "$0.003",
    tags: ["payments", "usdc", "verification", "base", "arc"],
    description:
      "Verify that a transaction paid at least N USDC to an address on Base or Arc (handles Arc native-USDC logs). Returns verified true/false, confirmations, matching transfers and reasons. Use it to confirm a customer paid before delivering.",
    input: { chain: "arc", tx: "0x824aaffc374ee2d265e2849f1458364e9227a2d345472f0614753e27fcc307f4", to: "0xf6103b23fd7d528abd3fbcb25935a41fb731e5ba", minAmount: "0.01" },
    inputSchema: {
      properties: { chain: chainParam, tx: hash, to: addr, minAmount: { type: "string" }, from: addr, minConfirmations: { type: "string" } },
      required: ["tx", "to"],
    },
    example: { verified: true, receivedUsdc: "0.01", confirmations: 120, reasons: [] },
  },
  {
    key: "GET /v1/tx/explain",
    path: "/v1/tx/explain",
    price: "$0.004",
    tags: ["transactions", "decode", "onchain", "base", "arc"],
    description:
      "Explain a Base or Arc transaction in plain JSON: status, confirmations, fee, method selector, created contract, and every ERC-20 transfer decoded with symbol and decimals.",
    input: { chain: "base", tx: "0xaa884cd272aea46834e3a1787c66492d1a2ec4940a9ae11ae5f1dc7c6fefe156" },
    inputSchema: { properties: { chain: chainParam, tx: hash }, required: ["tx"] },
    example: { status: "success", fee: { symbol: "ETH", amount: "0.0000021" }, tokenTransfers: [{ symbol: "USDC", amount: "5" }] },
  },
  {
    key: "GET /v1/network/status",
    path: "/v1/network/status",
    price: "$0.001",
    tags: ["gas", "fees", "network", "base", "arc"],
    description: "Live block height, gas price and fee estimates (transfer, ERC-20 transfer, contract call) for Base or Arc. On Arc fees are quoted directly in USDC.",
    input: { chain: "arc" },
    inputSchema: { properties: { chain: chainParam } },
    example: { chain: "arc", gasPriceGwei: "20", feeEstimates: { unit: "USDC", erc20Transfer65k: "0.0013" } },
  },
  {
    key: "GET /v1/usdc/balances",
    path: "/v1/usdc/balances",
    price: "$0.002",
    tags: ["usdc", "balance", "wallet", "base", "arc"],
    description: "USDC and native balance of one address on both Base and Arc in a single call.",
    input: { address: "0xFe5D81D8268CBaC025829CEdD11D5cF6962d4096" },
    inputSchema: { properties: { address: addr }, required: ["address"] },
    example: { balances: [{ chain: "base", usdc: "8.29" }, { chain: "arc", usdc: "0.44" }] },
  },
] as const;

export interface AppOptions {
  fetch?: FetchLike;
  facilitatorClient?: FacilitatorClient; // injected in tests
  depsOverride?: Partial<Deps>;
}

async function buildFacilitator(env: Env): Promise<FacilitatorClient> {
  const choice = (env.FACILITATOR ?? "payai").toLowerCase();
  if (choice === "cdp") {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) throw new Error("FACILITATOR=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets");
    const { createFacilitatorConfig } = await import("@coinbase/x402");
    return new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET));
  }
  const url = FACILITATOR_URLS[choice] ?? choice;
  if (!/^https:\/\//.test(url)) throw new Error(`bad FACILITATOR '${env.FACILITATOR}'`);
  return new HTTPFacilitatorClient({ url });
}

export function routesConfig(env: Env) {
  const network = (env.NETWORK ?? "eip155:8453") as `${string}:${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO ?? "")) throw new Error("PAY_TO must be set to a 0x address");
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return Object.fromEntries(
    PAID_ROUTES.map((r) => [
      r.key,
      {
        accepts: { scheme: "exact", price: r.price, network, payTo: env.PAY_TO, maxTimeoutSeconds: 120 },
        description: r.description,
        mimeType: "application/json",
        serviceName: env.SERVICE_NAME ?? "Northline ChainKit",
        tags: [...r.tags],
        ...(base ? { resource: base + r.path } : {}),
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            price: r.price + " USDC on Base (x402 exact)",
            how: "Retry with an x402 client (x402-fetch, x402-axios, CDP AgentKit); it reads the PAYMENT-REQUIRED header and pays automatically.",
            exampleQuery: r.input,
            docs: (base ?? "") + "/openapi.json",
          },
        }),
        extensions: {
          ...declareDiscoveryExtension({
            input: r.input,
            inputSchema: { type: "object", ...r.inputSchema },
            output: { example: r.example },
          }),
        },
      },
    ]),
  );
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof InputError) return c.json({ error: e.message }, 400);
  if (e instanceof RpcError) return c.json({ error: e.message }, 502);
  return c.json({ error: "internal_error" }, 500);
}

export function createApp(env: Env, opts: AppOptions = {}) {
  const app = new Hono();
  const f: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const deps: Deps = { fetch: f, ...opts.depsOverride };
  const routes = routesConfig(env);

  let server: x402ResourceServer | null = null;
  let mw: ReturnType<typeof paymentMiddleware> | null = null;
  const getMw = async () => {
    if (!mw) {
      const fac = opts.facilitatorClient ?? (await buildFacilitator(env));
      server = new x402ResourceServer(fac).register((env.NETWORK ?? "eip155:8453") as `${string}:${string}`, new ExactEvmScheme());
      server.registerExtension(bazaarResourceServerExtension);
      mw = paymentMiddleware(routes as never, server);
    }
    return mw;
  };

  // ---- free routes (must be registered before the payment middleware matches)
  const index = () => ({
    service: env.SERVICE_NAME ?? "Northline ChainKit",
    summary: "Pay-per-call onchain facts for agents on Base and Arc. x402, USDC on Base, no API key, no signup.",
    payment: { protocol: "x402 v2", scheme: "exact", network: env.NETWORK ?? "eip155:8453", asset: "USDC", payTo: env.PAY_TO },
    endpoints: PAID_ROUTES.map((r) => ({ method: "GET", path: r.path, price: r.price, description: r.description, example: { query: r.input } })),
    free: ["/", "/health", "/openapi.json", "/llms.txt", "/.well-known/x402", "/.well-known/x402.json"],
    chains: Object.values(CHAINS).map((c) => ({ key: c.key, chainId: c.chainId })),
    related: [
      {
        name: "Northline Unclaimed",
        url: UNCLAIMED_URL,
        summary: "Free check for crypto a wallet can still claim (airdrops, rewards, refunds, forgotten DEX balances); full report via x402 at /v1/report.",
        free: `${UNCLAIMED_URL}/v1/summary?address=`,
        paid: `${UNCLAIMED_URL}/v1/report?address=`,
      },
    ],
  });
  app.get("/", (c) => c.json(index()));
  app.get("/health", (c) => c.json({ ok: true }));
  const wellKnown = () => ({
    version: 1,
    resources: PAID_ROUTES.map((r) => (env.PUBLIC_BASE_URL ?? "") + r.path),
    instructions: "GET with query params; unpaid requests return HTTP 402 with an x402 v2 PAYMENT-REQUIRED header. See /openapi.json.",
  });
  app.get("/.well-known/x402", (c) => c.json(wellKnown()));
  app.get("/.well-known/x402.json", (c) => c.json(wellKnown()));
  app.get("/llms.txt", (c) =>
    c.text(
      [
        `# ${env.SERVICE_NAME ?? "Northline ChainKit"}`,
        "> Pay-per-call onchain facts for AI agents on Base and Arc, paid with x402 (USDC on Base). No signup.",
        "",
        ...PAID_ROUTES.map((r) => `- GET ${r.path} (${r.price}): ${r.description} Query: ${new URLSearchParams(r.input as Record<string, string>).toString()}`),
        "",
        "Unpaid requests get HTTP 402 with a PAYMENT-REQUIRED header; any x402 client (x402-fetch, x402-axios, CDP AgentKit) pays automatically.",
        "",
        "## Related",
        `- Northline Unclaimed (${UNCLAIMED_URL}): free check for crypto a wallet can still claim. Free: GET ${UNCLAIMED_URL}/v1/summary?address= . Paid (x402, $0.50 USDC on Base): GET ${UNCLAIMED_URL}/v1/report?address= . Sources: ${UNCLAIMED_URL}/sources.json`,
      ].join("\n"),
    ),
  );
  app.get("/openapi.json", (c) =>
    c.json({
      openapi: "3.1.0",
      info: { title: env.SERVICE_NAME ?? "Northline ChainKit", version: "1.0.0", description: "x402 pay-per-call onchain API (Base + Arc)." },
      servers: env.PUBLIC_BASE_URL ? [{ url: env.PUBLIC_BASE_URL }] : [],
      paths: Object.fromEntries(
        PAID_ROUTES.map((r) => [
          r.path,
          {
            get: {
              summary: r.description,
              "x-payment-info": { protocols: ["x402"], price: { mode: "fixed", currency: "USD", amount: r.price.replace("$", "") }, network: env.NETWORK ?? "eip155:8453", asset: "USDC" },
              parameters: Object.entries(r.inputSchema.properties).map(([name, schema]) => ({
                name,
                in: "query",
                required: ((r.inputSchema as { required?: readonly string[] }).required ?? []).includes(name),
                schema,
              })),
              responses: { "200": { description: "OK" }, "400": { description: "Bad input (no charge: x402 settles only on success)" }, "402": { description: "Payment required" } },
            },
          },
        ]),
      ),
    }),
  );

  // ---- payment gate: validate input BEFORE asking for payment so buyers never pay for a 400
  app.use("/v1/*", async (c, next) => {
    const q = c.req.query();
    // Unpaid requests always get the 402 challenge (directory crawlers probe with placeholder input).
    // Paid requests are validated first, so a buyer's payment is never verified/settled for a request that can only fail.
    const method = c.req.method;
    if (method === "HEAD") {
      // Answer HEAD probes with the same 402 headers as GET (and never run the paid handler for free).
      const res = await app.fetch(new Request(c.req.url, { method: "GET", headers: { accept: "application/json" } }));
      return new Response(null, { status: res.status === 200 ? 402 : res.status, headers: res.headers });
    }
    if (method !== "GET") return c.json({ error: "method_not_allowed", allow: "GET" }, 405, { allow: "GET" });
    const hasPayment = !!(c.req.header("payment-signature") || c.req.header("x-payment"));
    if (!hasPayment) return (await getMw())(c, next);
    try {
      if (q.chain !== undefined) getChain(q.chain);
      const p = c.req.path;
      const need = (k: string) => {
        if (!q[k]) throw new InputError(`missing query parameter '${k}'`);
      };
      if (p === "/v1/address/profile" || p === "/v1/usdc/balances") need("address");
      if (p === "/v1/payment/verify") (need("tx"), need("to"));
      if (p === "/v1/tx/explain") need("tx");
      // Validate formats too, so a buyer never pays for a request that can only fail.
      if (q.address !== undefined) assertAddress(q.address);
      if (q.to !== undefined) assertAddress(q.to, "to");
      if (q.from !== undefined) assertAddress(q.from, "from");
      if (q.tx !== undefined) assertTxHash(q.tx);
      if (q.minAmount !== undefined) parseUnits(q.minAmount, 6);
    } catch (e) {
      return errorResponse(c, e);
    }
    return (await getMw())(c, next);
  });

  app.get("/v1/address/profile", async (c) => {
    try {
      return c.json(await addressProfile(deps, getChain(c.req.query("chain")), c.req.query("address")!));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.get("/v1/payment/verify", async (c) => {
    try {
      const q = c.req.query();
      return c.json(await verifyPayment(deps, getChain(q.chain), { tx: q.tx!, to: q.to!, minAmount: q.minAmount, from: q.from, minConfirmations: q.minConfirmations }));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.get("/v1/tx/explain", async (c) => {
    try {
      return c.json(await explainTx(deps, getChain(c.req.query("chain")), c.req.query("tx")!));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.get("/v1/network/status", async (c) => {
    try {
      return c.json(await networkStatus(deps, getChain(c.req.query("chain"))));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.get("/v1/usdc/balances", async (c) => {
    try {
      return c.json(await usdcBalances(deps, [CHAINS.base, CHAINS.arc], c.req.query("address")!));
    } catch (e) {
      return errorResponse(c, e);
    }
  });
  app.notFound((c) => c.json({ error: "not_found", see: "/" }, 404));
  return app;
}
