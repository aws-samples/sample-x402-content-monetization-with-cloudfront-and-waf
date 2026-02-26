# x402 Traffic Generator

Sends real HTTP traffic to a deployed CloudFront distribution with actual on-chain x402 payments via CDP Server Wallet.

## Setup

1. Copy the env file and fill in your CDP credentials:

```bash
cp scripts/.env.example scripts/.env
```

2. Get credentials at https://cdp.coinbase.com

3. Fund the wallet with USDC on Base Sepolia. The wallet address is printed on first run. Use the [Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet) for testnet ETH/USDC.

## Usage

```bash
# Run full playlist (18 requests across all routes)
npx tsx scripts/traffic-gen.ts

# Custom options
npx tsx scripts/traffic-gen.ts --url https://your-distro.cloudfront.net
npx tsx scripts/traffic-gen.ts --rounds 5          # limit to 5 requests
npx tsx scripts/traffic-gen.ts --delay 2000         # 2s between requests
npx tsx scripts/traffic-gen.ts --no-pay             # dry run, no payments
```

## What it does

Builds a deterministic playlist of 18 requests, shuffled to simulate mixed traffic:

| Type | Count | Description |
|------|-------|-------------|
| Paying bots | 12 | 6 bots round-robin across `/api/{sports,fashion,politics}.json` and `/articles/{sports,fashion,politics}.html` |
| Humans | 4 | Free access to `/` and 3 article pages |
| Verify failure | 1 | Garbage `X-PAYMENT` header, expects 402 |
| Settlement failure | 1 | Pays for `/api/deleted.json` (no origin file), expects 403 |

## Sample output

```
💰 GPTBot → /api/politics.json → 200 (3945ms) settled
🧑 human → / → 200 (116ms)
❌ GPTBot → /api/sports.json (verify fail) → 402 (104ms)
❌ ClaudeBot → /api/deleted.json (settle fail) → 403 (755ms)
```
