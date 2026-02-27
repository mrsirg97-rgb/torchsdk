# Torch SDK

TypeScript SDK for [Torch Market](https://torch.market) — the fair-launch token protocol on Solana.

Read on-chain state, build transactions, and interact with bonding curves, vaults, governance, lending, and the SAID Protocol — all directly via Solana RPC. No API middleman.

## Design

for in depth sdk design, refer to [design.md](./design.md).

## Audit

for sdk audit, refer to [audit.md](./audit.md).

## Versioning

SDK version tracks the on-chain program IDL version.

### v3.7.22

- **V33 Buyback Removal + Lending Cap Increase** — `buildAutoBuybackTransaction` removed (~180 lines of SDK code). The on-chain `execute_auto_buyback` instruction was removed in V33 (program v3.7.7, 27 instructions). Treasury simplified to: fee harvest → sell high → SOL → lending yield + epoch rewards. Lending utilization cap increased from 50% to 70%. `AutoBuybackParams` type removed. IDL updated to v3.7.7. 39 Kani proofs all passing. Binary size reduced ~6% (850 KB → 804 KB).
- **V32 Protocol Fee Change**

### v3.7.20

- **Legacy Tokens** - blacklisted tokens now marked legacy and withdraw only.

### v3.7.18

- **V31 Zero-Burn Migration** — IDL updated to v3.7.5 (program v3.7.5). CURVE_SUPPLY 750M → 700M, TREASURY_LOCK_TOKENS 250M → 300M. Zero tokens burned at migration — vault remainder exactly equals price-matched pool allocation. Transfer fee 0.1% → 0.25% for new tokens. Vote return now redirects to treasury lock (community reserve) instead of Raydium LP. `buildMigrateTransaction` passes `treasuryLock` PDA and `treasuryLockTokenAccount` to the new on-chain context. 38 Kani proofs all passing (including 3 new zero-excess-burn proofs and Flame price-match proof). All three tiers (Spark/Flame/Torch) preserved.

### v3.7.17

- **`getAllLoanPositions`** — New SDK function scans all on-chain LoanPosition accounts for a given mint. Returns active positions with computed health status (collateral value, LTV, health), sorted liquidatable-first. Fetches Raydium pool price once (not per-position) for efficient valuation. New types: `LoanPositionWithKey` (extends `LoanPositionInfo` with `borrower` address), `AllLoanPositionsResult`.

### v3.7.16

- **V29 On-Chain Metadata** — Metaplex `buildAddMetadataTransaction` removed (temporary backfill complete — all active tokens now use Token-2022 metadata extensions). New `getTokenMetadata(connection, mint)` read-only function returns `{ name, symbol, uri, mint }` from on-chain Token-2022 metadata. Transfer fee updated from 1% to 0.1% on-chain. IDL updated to v3.7.4 (28 instructions).

### v3.7.10

- **V20 Swap Fees to SOL** — New `buildSwapFeesToSolTransaction` bundles `create_idempotent(treasury_wsol)` + `harvest_fees` + `swap_fees_to_sol` in one atomic transaction. Sells harvested Token-2022 transfer fee tokens back to SOL via Raydium CPMM. Treasury PDA signs the swap, WSOL unwrapped to SOL, proceeds added to `treasury.sol_balance` and tracked in `treasury.harvested_fees`. Set `harvest=false` to skip harvest if already done separately. New type: `SwapFeesToSolParams`.
- **Vault ordering bug fix** — Fixed `validate_pool_accounts` vault ordering in `swap_fees_to_sol` handler. Vaults are now passed in pool order (by mint pubkey) instead of swap direction, preventing false validation failures for tokens where `mint < WSOL` (~2.6% of tokens).
- **28 instructions** — IDL updated to v3.7.10 (28 instructions, up from 27). *(27 instructions as of v3.7.22 — buyback removed in V33)*

### v3.7.4

- **V28 Migration Payer Reimbursement** — The on-chain program now snapshots the payer's lamports before and after Raydium CPIs, then reimburses the exact migration cost from the treasury. Net cost to payer: 0 SOL. `MIN_MIGRATION_SOL` (1.5 SOL safety floor) replaces the old `RAYDIUM_POOL_CREATION_FEE` (0.15 SOL) constant. The inline auto-migrate path in `buildBuyTransactionInternal` has been collapsed into a single `buildMigrateTransaction()` call (~50 lines removed). IDL updated to v3.7.1. 36 Kani proofs all passing on program v3.7.1.

### v3.7.3

- **`fetchWithFallback` resilience** — Improved metadata fetch with gateway URL fallback.

### v3.7.2

- **Auto-Buyback Client-Side Pre-Checks** — `buildAutoBuybackTransaction` added with 6-point client-side validation. *(Removed in v3.7.22 — buyback instruction removed from on-chain program in V33)*
- **Harvest Fees Auto-Discovery** — `buildHarvestFeesTransaction` auto-discovers token accounts with withheld Token-2022 transfer fees via `getTokenLargestAccounts` + `unpackAccount` + `getTransferFeeAmount`. New optional `sources` field on `HarvestFeesParams` for explicit source accounts. Compute budget scales dynamically (base 200k + 20k per source account). Source accounts passed as `remainingAccounts` to the on-chain program. Graceful fallback if RPC doesn't support `getTokenLargestAccounts` (e.g. Surfpool local validators).
- **E2E Test Coverage** — New test sections for harvest fees across all three test suites (mainnet fork, devnet, tiers). Harvest tests validate treasury token balance changes.

### v3.7.1

- **`buildAutoBuybackTransaction`** — Added for permissionless treasury buybacks on Raydium. *(Removed in v3.7.22 — on-chain instruction removed in V33)*
- **`buildHarvestFeesTransaction`** — New SDK function for permissionless Token-2022 transfer fee harvesting. Collects accumulated 0.1% transfer fees from token accounts into the treasury.
- **New types** — `HarvestFeesParams` exported.

### v3.7.0

- **`update_authority` Removed (V28)** — The `update_authority` admin instruction has been removed from the on-chain program. Authority transfer is now done at deployment time via multisig tooling rather than an on-chain instruction, reducing the protocol's admin attack surface. 27 instructions total (down from 28). Minimal admin surface: only `initialize` and `update_dev_wallet` require authority.
- **Pre-migration Buyback Removed** — Pre-migration bonding curve buyback handler and context removed. *(Post-migration `execute_auto_buyback` also removed in V33)*
- **V27 Treasury Lock + PDA Pool Validation** — 300M tokens (30%) locked in TreasuryLock PDA at creation; 700M (70%) for bonding curve. IVS = 3BT/8, IVT = 756.25M tokens — 13.44x multiplier. PDA-based Raydium pool validation replaces runtime validation in `Borrow`, `Liquidate`, and `VaultSwap` contexts.
- **36 Kani Proof Harnesses** — All passing. Including V25 supply conservation, V26 SOL wrapping conservation, lending lifecycle with interest.
- **IDL updated to v3.7.0** (27 instructions).

### v3.6.8

- **Permissionless DEX Migration (V26)** — New `buildMigrateTransaction` builds the two-step migration (fund WSOL + migrate to Raydium) in a single transaction. Anyone can trigger migration for bonding-complete tokens — payer covers rent (~0.02 SOL), treasury pays 0.15 SOL Raydium pool fee.
- **Pool Account Validation (V27)** — Tightened Raydium pool validation: AMM config constrained to known program constant, pool state ownership verified against Raydium CPMM program ID. Closes account substitution vector.
- **Update Authority (V28)** — New `update_authority` admin instruction for transferring protocol authority. Immediate, authority-only. *(Removed in v3.7.0)*
- **Lending `sol_balance` Bug Fix** — Treasury `sol_balance` now correctly decremented on borrow and incremented on repay/liquidation. Critical accounting fix.
- **Lending Utilization Cap** — `getLendingInfo` now returns actual borrowable amount: `(sol_balance * 50%) - total_sol_lent`, matching on-chain enforcement.
- **Live Raydium Pool Price** — `getToken()` fetches live pool vault balances for migrated tokens instead of frozen bonding curve virtual reserves.
- **Dynamic Network Detection** — SDK evaluates network at call time via `globalThis.__TORCH_NETWORK__` (browser runtime) or `process.env.TORCH_NETWORK` (Node.js). Raydium addresses switch automatically between mainnet and devnet.
- **35 Kani Proof Harnesses** — Including V25 supply conservation, V26 SOL wrapping conservation, lending lifecycle with interest.
- **IDL updated to v3.6.0** (35 instructions).

### v3.5.1

- **V25 Pump-Style Token Distribution** — New virtual reserve model: IVS = bonding_target/8 (6.25-25 SOL), IVT = 900M tokens, ~81x multiplier across all tiers. Reverted V24 per-tier treasury fees to flat 20%→5% for all tiers.

### v3.4.0

- **Tiered Fee Structure (V24)** — Dynamic treasury SOL rate per-tier. Legacy tokens get Torch rates. `calculateTokensOut` accepts optional `bondingTarget` parameter.

### v3.3.0

- **Tiered Bonding Curves (V23)** — Creators choose a graduation target at token creation: Spark (50 SOL), Flame (100 SOL), or Torch (200 SOL, default). New optional `sol_target` parameter on `buildCreateTokenTransaction`.
- **Security: `harvest_fees` hardened (V3.2.1)** — Fixed critical vulnerability where `treasury_token_account` was unconstrained. Independent auditor verified.
- **Kani proofs updated** — 20/20 harnesses passing for all tiers.

### v3.2.4

- **Metadata fetch timeout** — 10s AbortController in `fetchWithFallback`
- **Explicit slippage validation** — throws on out-of-range instead of silent clamping
- **IDL-derived discriminator** — LoanPosition discriminator from Anchor IDL

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
| `getTokenMetadata(connection, mint)` | Get on-chain Token-2022 metadata (name, symbol, uri) |
| `getLoanPosition(connection, mint, wallet)` | Get a wallet's loan position |
| `getAllLoanPositions(connection, mint)` | Get all active loan positions for a token (sorted by health) |

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
| `buildMigrateTransaction(connection, params)` | Migrate bonding-complete token to Raydium DEX (permissionless, payer reimbursed by treasury) |
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

#### Treasury Cranks (Permissionless)

| Function | Description |
|----------|-------------|
| `buildHarvestFeesTransaction(connection, params)` | Harvest Token-2022 transfer fees into treasury. Auto-discovers source accounts or accepts explicit list. |
| `buildSwapFeesToSolTransaction(connection, params)` | Swap harvested transfer fee tokens to SOL via Raydium. Bundles harvest + swap in one atomic tx. |

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
{ creator: string, name: string, symbol: string, metadata_uri: string, sol_target?: number }
// sol_target: 50_000_000_000 (Spark), 100_000_000_000 (Flame), 200_000_000_000 (Torch, default)

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

// Migrate (permissionless — anyone can trigger for bonding-complete tokens, treasury reimburses payer)
{ mint: string, payer: string }

// Swap Fees to SOL (permissionless — bundles harvest + swap, treasury reimburses)
{ mint: string, payer: string, minimum_amount_out?: number, harvest?: boolean, sources?: string[] }

// Rewards (optional vault routing)
{ user: string, vault?: string }                                       // claim protocol rewards
```

## Network Configuration

The SDK detects the network at runtime. No rebuild needed to switch between mainnet and devnet.

```typescript
// Browser: set before SDK calls (e.g., in a network switcher)
(globalThis as any).__TORCH_NETWORK__ = 'devnet'

// Node.js: set via environment variable
// TORCH_NETWORK=devnet npx tsx your-script.ts
```

The SDK checks `globalThis.__TORCH_NETWORK__` first (for browser runtime switching), then falls back to `process.env.TORCH_NETWORK`. When set to `'devnet'`, all Raydium addresses automatically switch to devnet versions.

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

Test coverage: create token, vault lifecycle (create/deposit/query/withdraw/withdraw tokens), buy (direct + vault), link/unlink wallet, sell, star, messages, confirm, full bonding to graduation (50/100/200 SOL tiers), permissionless Raydium migration (V26 two-step), harvest transfer fees (auto-discovery), swap fees to SOL (harvest + Raydium swap in one tx), borrow, repay, vault swap (buy + sell on Raydium DEX), vault-routed liquidation, protocol reward claims (epoch volume + vault-routed claim).

A separate devnet E2E test (`tests/test_devnet_e2e.ts`) validates the full lifecycle against Solana devnet with `TORCH_NETWORK=devnet`. A tiers test (`tests/test_tiers.ts`) validates the full lifecycle across all three graduation tiers (Spark/Flame/Torch) including harvest and lending.

## License

MIT
