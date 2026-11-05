# Northline ChainKit

Pay-per-call onchain facts for AI agents on **Base** and **Arc**. **x402 + USDC on Base**, works over plain HTTP or as an **MCP server**. No API keys, no signup: each call costs $0.001–$0.005, paid inline.

- **Live API:** https://northline-chainkit.northline-c86.workers.dev
- **MCP endpoint (Streamable HTTP):** `https://northline-chainkit.northline-c86.workers.dev/mcp`
- **OpenAPI:** [/openapi.json](https://northline-chainkit.northline-c86.workers.dev/openapi.json) · **LLM docs:** [/llms.txt](https://northline-chainkit.northline-c86.workers.dev/llms.txt) · **x402 discovery:** [/.well-known/x402](https://northline-chainkit.northline-c86.workers.dev/.well-known/x402)
- **MCP Registry:** `dev.workers.northline-c86.northline-chainkit/chainkit`

## Routes and prices

| Route | Price | What you get |
|---|---|---|
| `/v1/address/profile` | $0.005 | EOA / contract / EIP-7702, proxy slots, owner(), Safe threshold, ERC-20 metadata, USDC + native, Sourcify, risk flags |
| `/v1/payment/verify` | $0.003 | Did this tx pay ≥ N USDC to `to`? (Base + Arc native-USDC) |
| `/v1/tx/explain` | $0.004 | Status, confirmations, fee, selector, created contract, decoded ERC-20 transfers |
| `/v1/network/status` | $0.001 | Block, gas price, fee estimates |
| `/v1/usdc/balances` | $0.002 | USDC + native on Base and Arc |

## MCP

```json
{ "mcpServers": { "northline-chainkit": { "url": "https://northline-chainkit.northline-c86.workers.dev/mcp" } } }
```

## Self-host

```bash
npm ci
npm test
npx wrangler deploy
```

Set `PAY_TO` in `wrangler.toml` to your wallet. Facilitator defaults to PayAI (no key needed).

## Related

- [Northline WebKit](https://github.com/northlinebuilds/northline-webkit) — pay-per-call web tools (URL → markdown, DNS, email/domain checks).

## License

MIT
