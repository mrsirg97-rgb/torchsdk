# Torch SDK

TypeScript SDK for building on [Torch Market](https://torch.market) — the fair-launch DAO launchpad on Solana.

Read on-chain state, build transactions, and interact with bonding curves, community treasuries, governance, lending, and the SAID Protocol — all directly via Solana RPC. No API middleman.

## Install

```bash
pnpm add torchsdk
```

Peer dependency: `@solana/web3.js ^1.98.0`

## Quick Start

```typescript
import { Connection } from "@solana/web3.js";
import {
  getTokens,
  getToken,
  buildBuyTransaction,
  buildSellTransaction,
  confirmTransaction,
} from "torchsdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");

// List tokens on bonding curves
const { tokens } = await getTokens(connection, { status: "bonding", sort: "volume" });

// Get full token details
const token = await getToken(connection, "So11111111111111111111111111111111111111112");

// Buy tokens on a bonding curve (with optional on-chain message)
const { transaction, message } = await buildBuyTransaction(connection, {
  mint: "TOKEN_MINT_ADDRESS",
  buyer: "YOUR_WALLET_ADDRESS",
  amount_sol: 100_000_000, // 0.1 SOL (in lamports)
  slippage_bps: 500,       // 5% slippage
  vote: "burn",            // vote to burn treasury tokens on migration
  message: "gm",           // optional — bundled as SPL Memo in the same tx
});

// Sign and send the transaction with your wallet...

// Confirm for SAID Protocol reputation
const result = await confirmTransaction(connection, signature, walletAddress);
// result.event_type: "trade_complete" | "token_launch" | "governance_vote"
```

## API Reference

### Token Data

| Function | Description |
|----------|-------------|
| `getTokens(connection, params?)` | List tokens with filtering and sorting |
| `getToken(connection, mint)` | Get full token details |
| `getHolders(connection, mint)` | Get token holder list |
| `getMessages(connection, mint, limit?)` | Get trade-bundled messages for a token |
| `getLendingInfo(connection, mint)` | Get lending parameters for a migrated token |
| `getLoanPosition(connection, mint, wallet)` | Get a wallet's loan position |

### Quotes

| Function | Description |
|----------|-------------|
| `getBuyQuote(connection, mint, solAmount)` | Simulate a buy and get expected output |
| `getSellQuote(connection, mint, tokenAmount)` | Simulate a sell and get expected output |

### Transaction Builders

All builders return `{ transaction: Transaction, message: string }`. You sign and send.

| Function | Description |
|----------|-------------|
| `buildBuyTransaction(connection, params)` | Buy tokens on the bonding curve |
| `buildSellTransaction(connection, params)` | Sell tokens back to the bonding curve |
| `buildCreateTokenTransaction(connection, params)` | Launch a new token with bonding curve + treasury |
| `buildStarTransaction(connection, params)` | Star a token (sybil-resistant support signal) |
| `buildMessageTransaction(connection, params)` | Post a trade-bundled on-chain message |
| `buildBorrowTransaction(connection, params)` | Borrow SOL against token collateral |
| `buildRepayTransaction(connection, params)` | Repay a loan |
| `buildLiquidateTransaction(connection, params)` | Liquidate an underwater position |

### SAID Protocol

| Function | Description |
|----------|-------------|
| `verifySaid(wallet)` | Check SAID verification status and trust tier |
| `confirmTransaction(connection, signature, wallet)` | Confirm a tx on-chain for reputation tracking |

## Transaction Params

```typescript
// Buy
{ mint: string, buyer: string, amount_sol: number, slippage_bps?: number, vote?: "burn" | "return", message?: string }

// Sell
{ mint: string, seller: string, amount_tokens: number, slippage_bps?: number, message?: string }

// Create Token
{ creator: string, name: string, symbol: string, metadata_uri: string }

// Vote
{ mint: string, voter: string, vote: "burn" | "return" }

// Star
{ mint: string, user: string }

// Message
{ mint: string, sender: string, message: string }

// Borrow
{ mint: string, borrower: string, collateral_amount: number, sol_to_borrow: number }

// Repay
{ mint: string, borrower: string, sol_amount: number }

// Liquidate
{ mint: string, liquidator: string, borrower: string }
```

## Running the E2E Test

The test runs the full lifecycle against a [Surfpool](https://github.com/txtx/surfpool) mainnet fork: create, buy, sell, star, message, confirm, bond to completion, migrate to Raydium, borrow, and repay.

```bash
# Start a local Solana fork
surfpool start --network mainnet --no-tui

# Run the test
cd packages/sdk
npx tsx tests/test_e2e.ts
```

Expected output: `RESULTS: 13 passed, 0 failed`

## License

MIT
