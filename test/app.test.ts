import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createApp, PAID_ROUTES } from "../src/app";
import { makeFetch, fakeFacilitator, PAY_TO, word } from "./mocks";

const env = { PAY_TO, NETWORK: "eip155:8453", FACILITATOR: "payai", PUBLIC_BASE_URL: "https://chainkit.example.workers.dev" };
const rpc = makeFetch((m) => ({ eth_blockNumber: "0x100", eth_gasPrice: "0x4a817c800", eth_chainId: "0x13b2", eth_getBalance: "0x0", eth_call: word("0") } as any)[m]);

describe("free routes", () => {
  it("serves index, openapi, llms.txt without payment", async () => {
    const { client } = fakeFacilitator();
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    const idx: any = await (await app.request("/")).json();
    expect(idx.endpoints).toHaveLength(PAID_ROUTES.length);
    expect(idx.payment.payTo).toBe(PAY_TO);
    expect((await app.request("/openapi.json")).status).toBe(200);
    expect(await (await app.request("/llms.txt")).text()).toContain("/v1/payment/verify");
    expect((await app.request("/nope")).status).toBe(404);
  });
});

describe("x402 paywall", () => {
  it("never settles a paid request with bad input; unpaid bad input still gets the 402", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    const pay = { "payment-signature": "e30=" };
    expect((await app.request("/v1/address/profile?chain=base", { headers: pay })).status).toBe(400);
    expect((await app.request("/v1/address/profile?address=0x12", { headers: pay })).status).toBe(400);
    expect((await app.request("/v1/payment/verify?tx=0x1&to=0xFe5D81D8268CBaC025829CEdD11D5cF6962d4096", { headers: pay })).status).toBe(400);
    expect((await app.request("/v1/network/status?chain=solana", { headers: pay })).status).toBe(400);
    expect(log.verify).toBe(0);
    expect(log.settle).toBe(0);
    expect((await app.request("/v1/tx/explain?tx=string")).status).toBe(402);
    expect((await app.request("/v1/address/profile?address=0x12")).status).toBe(402);
    const head = await app.request("/v1/address/profile", { method: "HEAD" });
    expect(head.status).toBe(402);
    expect(head.headers.get("payment-required")).toBeTruthy();
    expect((await app.request("/v1/address/profile", { method: "POST" })).status).toBe(405);
    expect(log.settle).toBe(0);
  });

  it("lets bare directory probes reach the 402 challenge", async () => {
    const { client } = fakeFacilitator();
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    for (const r of PAID_ROUTES) expect((await app.request(r.path)).status).toBe(402);
    const wk: any = await (await app.request("/.well-known/x402")).json();
    expect(wk.resources[0]).toMatch(/^https:\/\/chainkit\.example\.workers\.dev\/v1\//);
    const oa: any = await (await app.request("/openapi.json")).json();
    expect(oa.paths["/v1/payment/verify"].get["x-payment-info"].price).toMatchObject({ mode: "fixed", amount: "0.003" });
  });

  it("returns 402 with exact USDC requirements and Bazaar metadata", async () => {
    const { client } = fakeFacilitator();
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    const res = await app.request("/v1/network/status?chain=arc");
    expect(res.status).toBe(402);
    const http = new x402HTTPClient(new x402Client());
    const pr = http.getPaymentRequiredResponse((n) => res.headers.get(n), await res.json().catch(() => undefined));
    expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, amount: "1000" });
    expect(pr.accepts[0].asset.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(pr.resource?.url).toBe("https://chainkit.example.workers.dev/v1/network/status");
    expect(pr.extensions?.bazaar).toBeTruthy();
    expect(JSON.stringify(pr.extensions?.bazaar)).toContain("arc");
    const again: any = await (await app.request("/v1/network/status?chain=arc")).json();
    expect(again.error).toBe("payment_required");
    expect(again.price).toContain("$0.001");
  });

  it("serves data and settles after a valid x402 payment (throwaway key, fake facilitator)", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    const first = await app.request("/v1/network/status?chain=arc");
    const buyer = new x402Client();
    registerExactEvmScheme(buyer, { signer: privateKeyToAccount(generatePrivateKey()) });
    const http = new x402HTTPClient(buyer);
    const pr = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
    const payload = await buyer.createPaymentPayload(pr);
    const headers = http.encodePaymentSignatureHeader(payload);
    const paid = await app.request("/v1/network/status?chain=arc", { headers });
    expect(paid.status).toBe(200);
    const body: any = await paid.json();
    expect(body).toMatchObject({ chain: "arc", chainId: 5042, gasPriceGwei: "20" });
    expect(log.verify).toBe(1);
    expect(log.settle).toBe(1);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
    expect(log.lastPayload.resource?.url ?? log.lastPayload.resource).toBeTruthy();
  });

  it("rejects an invalid payment without serving data", async () => {
    const { client, log } = fakeFacilitator({ valid: false });
    const app = createApp(env, { fetch: rpc.fetch, facilitatorClient: client });
    const first = await app.request("/v1/network/status");
    const buyer = new x402Client();
    registerExactEvmScheme(buyer, { signer: privateKeyToAccount(generatePrivateKey()) });
    const http = new x402HTTPClient(buyer);
    const pr = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
    const headers = http.encodePaymentSignatureHeader(await buyer.createPaymentPayload(pr));
    const res = await app.request("/v1/network/status", { headers });
    expect(res.status).toBe(402);
    expect(log.settle).toBe(0);
  });

  it("refuses to start without a valid PAY_TO", () => {
    expect(() => createApp({ PAY_TO: "nope" } as any)).toThrow(/PAY_TO/);
  });
});
