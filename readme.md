# Torch SDK

TypeScript SDK for [Torch Market](https://torch.market) — the fair-launch token protocol on Solana.

Read on-chain state, build transactions, and interact with bonding curves, vaults, governance, lending, and the SAID Protocol — all directly via Solana RPC. No API middleman.

## Design

for in depth sdk design, refer to [design.md](./design.md).

## Audit

for sdk audit, refer to [audit.md](./audit.md).

## Versioning

SDK version tracks the on-chain program IDL version. Starting from v3.2.0, both ship the same version number.

## What's New in v3.2.0

**Full Custody Vault + DEX Trading** — the vault now holds all assets (SOL and tokens). All operations route through the vault. The agent wallet is a disposable controller that holds nothing of value.

```
User (hardware wallet)
  ├── createVault()              → vault created, user auto-linked
  ├── depositVault(5 SOL)        → vault funded
  ├── linkWallet(agent)          → agent authorized as controller
  │
Agent (disposable wallet, ~0.01 SOL for gas)
  ├── buy(vault=user)            → vault SOL pays, tokens to vault ATA
  ├── sell(vault=user)           → vault tokens sold, SOL returns to vault
  ├── vaultSwap(buy)             → vault SOL → Raydium → tokens to vault ATA
  ├── vaultSwap(sell)            → vault tokens → Raydium → SOL to vault
  ├── borrow(vault=user)         → vault tokens locked, SOL to vault
  ├── repay(vault=user)          → vault SOL repays, tokens returned to vault
  ├── liquidate(vault=user)      → vault SOL pays, collateral to vault ATA
  ├── claimProtocolRewards(vault)→ protocol rewards SOL to vault
  ├── star(vault=user)           → vault SOL pays star fee
  │
User
  ├── withdrawVault()            → pull SOL (authority only)
  ├── withdrawTokens(mint)       → pull tokens (authority only)
  └── unlinkWallet(agent)        → revoke agent access instantly
```

Multiple wallets can share one vault. Deposit from a hardware wallet, trade from a hot wallet and an agent — all backed by the same SOL pool. All value stays in the vault.

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
| `buildBuyTransaction(connection, params)` | Buy tokens on bonding curve (vault-funded) |
| `buildDirectBuyTransaction(connection, params)` | Buy tokens (buyer pays directly, no vault) |
| `buildSellTransaction(connection, params)` | Sell tokens back to the bonding curve (vault-routed) |
| `buildVaultSwapTransaction(connection, params)` | Buy/sell migrated tokens on Raydium DEX (vault-routed) |
| `buildCreateTokenTransaction(connection, params)` | Launch a new token |
| `buildStarTransaction(connection, params)` | Star a token (0.05 SOL, vault-routed) |

#### Vault Management

| Function | Signer | Description |
|----------|--------|-------------|
| `buildCreateVaultTransaction` | creator | Create vault + auto-link creator |
| `buildDepositVaultTransaction` | depositor | Deposit SOL (permissionless) |
| `buildWithdrawVaultTransaction` | authority | Withdraw SOL |
| `buildWithdrawTokensTransaction` | authority | Withdraw tokens from vault ATA |
| `buildLinkWalletTransaction` | authority | Link a wallet to the vault |
| `buildUnlinkWalletTransaction` | authority | Unlink a wallet |
| `buildTransferAuthorityTransaction` | authority | Transfer admin control |

#### Lending (Post-Migration)

| Function | Description |
|----------|-------------|
| `buildBorrowTransaction(connection, params)` | Borrow SOL against token collateral (vault-routed) |
| `buildRepayTransaction(connection, params)` | Repay SOL debt (vault-routed) |
| `buildLiquidateTransaction(connection, params)` | Liquidate underwater position (vault-routed) |
| `buildClaimProtocolRewardsTransaction(connection, params)` | Claim protocol trading rewards (vault-routed) |

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

// Vault Swap (DEX trading for migrated tokens)
{ mint: string, signer: string, vault_creator: string, amount_in: number, minimum_amount_out: number, is_buy: boolean }

// Lending (all support optional vault?: string for vault routing)
{ mint: string, borrower: string, collateral_amount: number, sol_to_borrow: number, vault?: string }
{ mint: string, borrower: string, sol_amount: number, vault?: string }
{ mint: string, liquidator: string, borrower: string, vault?: string }

// Rewards (optional vault routing)
{ user: string, vault?: string }                                       // claim protocol rewards
```

## Vault Safety Model

The Torch Vault provides protocol-level full custody for AI agent interaction:

| Property | Guarantee |
|----------|-----------|
| **Full custody** | Vault holds all SOL and all tokens. Controller wallet holds nothing. |
| **Closed loop** | All operations return value to the vault. No leakage to controller. |
| **Authority separation** | Creator (immutable PDA seed) vs Authority (transferable admin). Agent wallets get *usage* rights, not ownership. |
| **One link per wallet** | A wallet can only belong to one vault. PDA uniqueness enforces this. |
| **Permissionless deposits** | Anyone can top up any vault. Hardware wallet deposits, agent spends. |
| **Instant revocation** | Authority can unlink a wallet at any time. |
| **Authority-only withdrawals** | Only the vault authority can withdraw SOL or tokens. Controllers cannot extract value. |

## Running the E2E Test

The test runs the full lifecycle against a [Surfpool](https://github.com/txtx/surfpool) mainnet fork.

```bash
# Start a local Solana fork
surfpool start --network mainnet --no-tui

# Run the test
npx tsx tests/test_e2e.ts
```

Expected output: `RESULTS: 32 passed, 0 failed`

Test coverage: create token, vault lifecycle (create/deposit/query/withdraw/withdraw tokens), buy (direct + vault), link/unlink wallet, sell, star, messages, confirm, full bonding to 200 SOL, Raydium migration, borrow, repay, vault swap (buy + sell on Raydium DEX), vault-routed liquidation, protocol reward claims (epoch volume + vault-routed claim).

## License

MIT
