# Torch SDK

TypeScript SDK for [Torch Market](https://torch.market) — the fair-launch token protocol on Solana.

Read on-chain state, build transactions, and interact with bonding curves, vaults, governance, lending, and the SAID Protocol — all directly via Solana RPC. No API middleman.

## Design

for in depth sdk design, refer to [design.md](./design.md).

## Audit

for sdk audit, refer to [audit.md](./audit.md).

## What's New in v2.0.0

**Torch Vault** — an on-chain SOL escrow for safe AI agent interaction.

The vault is a spending cap. You deposit SOL, link an agent wallet, and the agent buys tokens using the vault's funds. The agent can't withdraw, can't transfer SOL arbitrarily — it can only spend through the `buy` instruction. You (the authority) retain full control: withdraw anytime, unlink wallets, transfer authority.

```
User (hardware wallet)
  ├── createVault()          → vault created, user auto-linked
  ├── depositVault(5 SOL)    → vault funded
  ├── linkWallet(agent)      → agent can use vault for buys
  │
Agent (hot wallet, ~0.01 SOL for fees)
  ├── buy(vault=user)        → vault pays, agent receives tokens
  ├── sell()                 → agent sells tokens, keeps SOL
  │
User
  ├── withdrawVault()        → pull remaining SOL
  └── unlinkWallet(agent)    → revoke agent access
```

Multiple wallets can share one vault. Deposit from a hardware wallet, trade from a hot wallet and an agent — all backed by the same SOL pool.

## API Reference

### Token Data

| Function | Description |
|----------|-------------|
| `getTokens(connection, params?)` | List tokens with filtering and sorting |
| `getToken(connection, mint)` | Get full token details (metadata, treasury, votes, stars) |
| `getHolders(connection, mint)` | Get token holder list (excludes pools/vaults) |
| `getMessages(connection, mint, limit?)` | Get trade-bundled memos for a token |
| `getLendingInfo(connection, mint)` | Get lending parameters for a migrated token |
| `getLoanPosition(connection, mint, wallet)` | Get a wallet's loan position |

### Vault Queries

| Function | Description |
|----------|-------------|
| `getVault(connection, creator)` | Get vault state by creator pubkey |
| `getVaultForWallet(connection, wallet)` | Find vault by any linked wallet (reverse lookup) |
| `getVaultWalletLink(connection, wallet)` | Get link state (which vault, when linked) |

### Quotes

| Function | Description |
|----------|-------------|
| `getBuyQuote(connection, mint, solAmount)` | Simulate a buy — expected tokens, fees, price impact |
| `getSellQuote(connection, mint, tokenAmount)` | Simulate a sell — expected SOL, price impact |

### Transaction Builders

All builders return `{ transaction: Transaction, message: string }`. You sign and send.

#### Trading

| Function | Description |
|----------|-------------|
| `buildBuyTransaction(connection, params)` | Buy tokens (vault-funded, requires vault) |
| `buildDirectBuyTransaction(connection, params)` | Buy tokens (buyer pays directly, no vault) |
| `buildSellTransaction(connection, params)` | Sell tokens back to the bonding curve |
| `buildCreateTokenTransaction(connection, params)` | Launch a new token |
| `buildStarTransaction(connection, params)` | Star a token (0.05 SOL) |

#### Vault Management

| Function | Signer | Description |
|----------|--------|-------------|
| `buildCreateVaultTransaction` | creator | Create vault + auto-link creator |
| `buildDepositVaultTransaction` | depositor | Deposit SOL (permissionless) |
| `buildWithdrawVaultTransaction` | authority | Withdraw SOL |
| `buildLinkWalletTransaction` | authority | Link a wallet to the vault |
| `buildUnlinkWalletTransaction` | authority | Unlink a wallet |
| `buildTransferAuthorityTransaction` | authority | Transfer admin control |

#### Lending (Post-Migration)

| Function | Description |
|----------|-------------|
| `buildBorrowTransaction(connection, params)` | Borrow SOL against token collateral |
| `buildRepayTransaction(connection, params)` | Repay SOL debt |
| `buildLiquidateTransaction(connection, params)` | Liquidate underwater position |

### SAID Protocol

| Function | Description |
|----------|-------------|
| `verifySaid(wallet)` | Check SAID verification status and trust tier |
| `confirmTransaction(connection, signature, wallet)` | Confirm tx on-chain for reputation tracking |

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
  buildDirectBuyTransaction,
  buildSellTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildLinkWalletTransaction,
  getVault,
  confirmTransaction,
} from "torchsdk";

const connection = new Connection("https://api.mainnet-beta.solana.com");
```

### Set Up a Vault

```typescript
// 1. Create vault (user wallet)
const { transaction: createTx } = await buildCreateVaultTransaction(connection, {
  creator: userWallet,
});
// sign and send createTx...

// 2. Deposit SOL
const { transaction: depositTx } = await buildDepositVaultTransaction(connection, {
  depositor: userWallet,
  vault_creator: userWallet,
  amount_sol: 5_000_000_000, // 5 SOL
});
// sign and send depositTx...

// 3. Link an agent wallet
const { transaction: linkTx } = await buildLinkWalletTransaction(connection, {
  authority: userWallet,
  vault_creator: userWallet,
  wallet_to_link: agentWallet,
});
// sign and send linkTx...
```

### Trade with Vault

```typescript
// Agent buys tokens — vault pays
const { transaction, message } = await buildBuyTransaction(connection, {
  mint: "TOKEN_MINT_ADDRESS",
  buyer: agentWallet,
  amount_sol: 100_000_000,     // 0.1 SOL (in lamports)
  slippage_bps: 500,           // 5% slippage
  vote: "burn",                // governance vote on first buy
  vault: userWallet,           // vault creator key → vault pays
});
// agent signs and sends...

// Check vault balance
const vault = await getVault(connection, userWallet);
console.log(`Vault: ${vault.sol_balance} SOL, ${vault.linked_wallets} wallets`);
```

### Direct Buy (No Vault — Human Use Only)

```typescript
// Buyer pays directly from their wallet — no vault safety
const { transaction } = await buildDirectBuyTransaction(connection, {
  mint: "TOKEN_MINT_ADDRESS",
  buyer: walletAddress,
  amount_sol: 100_000_000,
  slippage_bps: 500,
  vote: "burn",
});
```

## Transaction Params

```typescript
// Buy (vault-funded — recommended for agents)
{
  mint: string,
  buyer: string,
  amount_sol: number,          // lamports
  slippage_bps?: number,       // default 100 (1%)
  vote?: "burn" | "return",    // required on first buy
  message?: string,            // optional SPL Memo (max 500 chars)
  vault: string,               // vault creator pubkey (required)
}

// Direct Buy (no vault — human use only)
{
  mint: string,
  buyer: string,
  amount_sol: number,          // lamports
  slippage_bps?: number,       // default 100 (1%)
  vote?: "burn" | "return",    // required on first buy
  message?: string,            // optional SPL Memo (max 500 chars)
}

// Sell
{
  mint: string,
  seller: string,
  amount_tokens: number,       // raw units (with decimals)
  slippage_bps?: number,
  message?: string,
}

// Create Token
{ creator: string, name: string, symbol: string, metadata_uri: string }

// Star
{ mint: string, user: string }

// Vault
{ creator: string }                                                    // create
{ depositor: string, vault_creator: string, amount_sol: number }       // deposit
{ authority: string, vault_creator: string, amount_sol: number }       // withdraw
{ authority: string, vault_creator: string, wallet_to_link: string }   // link
{ authority: string, vault_creator: string, wallet_to_unlink: string } // unlink
{ authority: string, vault_creator: string, new_authority: string }    // transfer

// Lending
{ mint: string, borrower: string, collateral_amount: number, sol_to_borrow: number }
{ mint: string, borrower: string, sol_amount: number }
{ mint: string, liquidator: string, borrower: string }
```

## Vault Safety Model

The Torch Vault provides protocol-level safety for AI agent interaction:

| Property | Guarantee |
|----------|-----------|
| **Spending cap** | Vault balance is finite. Agent can't spend more than what's deposited. |
| **Buy-only** | Vault SOL can only flow through the `buy` instruction. No arbitrary transfers. |
| **Authority separation** | Creator (immutable PDA seed) vs Authority (transferable admin). Agent wallets get *usage* rights, not ownership. |
| **One link per wallet** | A wallet can only belong to one vault. PDA uniqueness enforces this. |
| **Permissionless deposits** | Anyone can top up any vault. Hardware wallet deposits, agent spends. |
| **Instant revocation** | Authority can unlink a wallet at any time. |
| **Token custody** | Tokens go to the buyer's wallet, not the vault. The agent holds its own tokens. |

## Running the E2E Test

The test runs the full lifecycle against a [Surfpool](https://github.com/txtx/surfpool) mainnet fork.

```bash
# Start a local Solana fork
surfpool start --network mainnet --no-tui

# Run the test
npx tsx tests/test_e2e.ts
```

Expected output: `RESULTS: 22 passed, 0 failed`

Test coverage: create token, vault lifecycle (create/deposit/query/withdraw), buy (direct + vault), link/unlink wallet, sell, star, messages, confirm, full bonding to 200 SOL, Raydium migration, borrow, repay.

## License

MIT
