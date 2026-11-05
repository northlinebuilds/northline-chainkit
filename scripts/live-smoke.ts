// Read-only: runs the paid-endpoint logic directly against real public RPCs. No payment, no signing, no writes.
import { CHAINS } from "../src/chains";
import { addressProfile, verifyPayment, explainTx, networkStatus, usdcBalances } from "../src/logic";
const deps = { fetch: (u: string, i?: RequestInit) => fetch(u, i) };
const show = (label: string, v: unknown) => console.log(`\n== ${label}\n` + JSON.stringify(v, null, 1).slice(0, 900));
show("arc network", await networkStatus(deps, CHAINS.arc));
show("base network", await networkStatus(deps, CHAINS.base));
show("base USDC profile", await addressProfile(deps, CHAINS.base, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"));
show("arc PayLink profile", await addressProfile(deps, CHAINS.arc, "0xF6103B23fD7d528Abd3fBcB25935a41FB731E5Ba"));
show("verify PayLink smoke payment on Arc", await verifyPayment(deps, CHAINS.arc, { tx: "0x824aaffc374ee2d265e2849f1458364e9227a2d345472f0614753e27fcc307f4", to: "0xF6103B23fD7d528Abd3fBcB25935a41FB731E5Ba", minAmount: "0.01" }));
show("explain a recent Base tx", await explainTx(deps, CHAINS.base, "" + (process.argv[2] ?? "0xaa884cd272aea46834e3a1787c66492d1a2ec4940a9ae11ae5f1dc7c6fefe156")));
show("our balances", await usdcBalances(deps, [CHAINS.base, CHAINS.arc], "0xFe5D81D8268CBaC025829CEdD11D5cF6962d4096"));
