# x402 Traffic Generator

Sends real HTTP traffic to a deployed CloudFront distribution with actual on-chain x402 payments on Base or Solana.

## Setup

1. Copy the env file and provide credentials for the network you want to pay on:

```bash
cp scripts/.env.example scripts/.env
```

2. For Base networks, set `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET` from https://cdp.coinbase.com

3. For Solana networks, set `SVM_PRIVATE_KEY` to a base58-encoded 64-byte secret key.

4. Fund the wallet with USDC on the target network. For testnet Base, use the [Base Sepolia faucet](https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet). For Solana Devnet, fund a Devnet wallet and mint or bridge Devnet USDC before running paid requests.

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
