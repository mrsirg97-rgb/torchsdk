# Torch SDK — Design Document

> TypeScript SDK for the Torch Market protocol on Solana. Version 2.0.0.

## Overview

The Torch SDK is a stateless, RPC-first TypeScript library for interacting with the Torch Market protocol. It reads on-chain state directly from Solana, builds unsigned transactions locally, and returns them for the caller to sign and submit. There is no API server, no websocket dependency, and no custody of keys.

The SDK is designed for AI agent integration. The core safety primitive is the **Torch Vault** — an on-chain SOL escrow that caps what an agent can spend. The vault is integrated into the buy flow so that agents trade with vault funds, not their own wallet balance.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     CONSUMER (Agent / App)                │
│                                                          │
│  1. Call SDK function (e.g. buildBuyTransaction)         │
│  2. Receive unsigned Transaction                         │
│  3. Sign locally with wallet/keypair                     │
│  4. Submit to Solana RPC                                 │
└──────────────┬───────────────────────────┬───────────────┘
               │ read                      │ build
               ▼                           ▼
┌──────────────────────────┐  ┌────────────────────────────┐
│      Token Queries       │  │   Transaction Builders     │
│                          │  │                            │
│  getTokens()             │  │  buildBuyTransaction()     │
│  getToken()              │  │  buildSellTransaction()    │
│  getHolders()            │  │  buildCreateTokenTx()      │
│  getMessages()           │  │  buildStarTransaction()    │
│  getLendingInfo()        │  │  buildBorrowTransaction()  │
│  getLoanPosition()       │  │  buildRepayTransaction()   │
│  getVault()              │  │  buildLiquidateTransaction │
│  getVaultForWallet()     │  │  buildCreateVaultTx()      │
│  getVaultWalletLink()    │  │  buildDepositVaultTx()     │
│                          │  │  buildWithdrawVaultTx()    │
│                          │  │  buildLinkWalletTx()       │
│                          │  │  buildUnlinkWalletTx()     │
│                          │  │  buildTransferAuthorityTx()│
└──────────┬───────────────┘  └──────────┬─────────────────┘
           │                             │
           ▼                             ▼
┌──────────────────────────────────────────────────────────┐
│                    Program Layer                          │
│                                                          │
│  PDA derivation    IDL decoding    Quote math            │
│  Account types     Anchor Program  Raydium PDAs          │
└──────────────────────────┬───────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│              Solana RPC (mainnet / validator)             │
│                                                          │
│  getProgramAccounts    getAccountInfo    sendTransaction  │
└──────────────────────────────────────────────────────────┘
```

## Module Structure

```
src/
├── index.ts            Public API — all exports
├── types.ts            TypeScript interfaces (params, results, types)
├── constants.ts        Program ID, PDA seeds, token constants, blacklist
├── program.ts          Anchor IDL, PDA derivation, on-chain types, math
├── tokens.ts           Read-only queries (tokens, holders, vault, lending)
├── transactions.ts     Transaction builders (buy, sell, vault, lending)
├── quotes.ts           Buy/sell quote calculations (no RPC write)
├── said.ts             SAID Protocol integration (verify, confirm)
├── gateway.ts          Irys metadata fetch with fallback
└── torch_market.json   Anchor IDL (v3.0.0, 27 instructions)
```

### Dependency Graph

```
index.ts ──→ tokens.ts ──→ program.ts ──→ constants.ts
         ──→ transactions.ts ──→ program.ts
                             ──→ tokens.ts (fetchTokenRaw)
         ──→ quotes.ts ──→ program.ts
                       ──→ tokens.ts (fetchTokenRaw)
         ──→ said.ts ──→ constants.ts
         ──→ types.ts (type-only)
```

No circular dependencies. `program.ts` is the foundation — it owns PDA derivation, Anchor types, and math. `tokens.ts` owns all read-only RPC queries. `transactions.ts` owns all write operations.

---

## Design Principles

### 1. Stateless

Every function takes a `Connection` as the first argument. No global state, no singletons, no connection pools. The caller owns the connection lifecycle.

### 2. Unsigned Transactions

All `build*Transaction` functions return `{ transaction: Transaction, message: string }`. The SDK never signs. The caller signs with their keypair and submits. This keeps key material out of the SDK entirely.

### 3. RPC-First

All data comes from Solana RPC. Token listings use `getProgramAccounts` with discriminator filters. Token details use `getAccountInfo`. No indexer, no API server, no database.

### 4. Vault-Aware

The buy transaction builder accepts an optional `vault` parameter. When provided, the transaction includes the TorchVault and VaultWalletLink accounts so the on-chain program debits the vault instead of the buyer's wallet. When omitted, the buy works exactly as before (backward compatible).

### 5. Agent-Safe by Default

The SDK is designed so that an agent wallet:
- Holds minimal SOL (~0.01) for transaction fees
- Spends from a vault with a finite balance (spending cap)
- Cannot withdraw from the vault (only the authority can)
- Cannot transfer vault SOL arbitrarily (vault SOL can only flow through `buy`)
- Receives tokens in its own wallet (can sell freely)

---

## Torch Vault — Safety Model

The Torch Vault is the core safety primitive for AI agent interaction with the protocol. It solves the problem of giving an agent a wallet with SOL — without the vault, the agent could drain the wallet through any transaction, not just token buys.

### How It Works

```
┌─────────────────────────────────────────────────────┐
│                  VAULT LIFECYCLE                      │
│                                                      │
│  User (hardware wallet)                              │
│    │                                                 │
│    ├── createVault()     → TorchVault PDA created    │
│    ├── depositVault()    → SOL into vault escrow     │
│    ├── linkWallet(agent) → agent can use vault       │
│    │                                                 │
│  Agent (hot wallet)                                  │
│    │                                                 │
│    ├── buy(vault=creator) → vault pays, agent gets   │
│    │                        tokens in its own wallet  │
│    ├── sell()             → agent sells tokens,       │
│    │                        SOL goes to agent wallet  │
│    │                                                  │
│  User                                                │
│    ├── withdrawVault()   → pull remaining SOL out     │
│    └── unlinkWallet()    → revoke agent access        │
└─────────────────────────────────────────────────────┘
```

### Multi-Wallet Identity

A single vault can be used by multiple wallets through VaultWalletLink PDAs:

```
Hardware Wallet ──┐
                  │
Hot Wallet ───────┼──→ VaultWalletLink ──→ TorchVault (shared SOL pool)
                  │
Agent Wallet ─────┘
```

Each wallet has a reverse-pointer PDA: `["vault_wallet", wallet.key()]`. Given any wallet, derive its link PDA to find which vault it belongs to. No enumeration needed.

### Permission Model

| Action | Who | Enforced By |
|--------|-----|-------------|
| Create vault | Anyone | PDA uniqueness (one per creator) |
| Deposit SOL | Anyone | No auth check (permissionless) |
| Withdraw SOL | Authority only | `has_one = authority` |
| Link wallet | Authority only | `has_one = authority` |
| Unlink wallet | Authority only | `has_one = authority` |
| Transfer authority | Authority only | `has_one = authority` |
| Buy with vault | Any linked wallet | `vault_wallet_link.vault == torch_vault.key()` |
| Buy without vault | Anyone | Unchanged |

### What the Vault Controls

- **Buy**: vault pays SOL. This is the controlled operation.
- **Sell**: agent receives SOL directly. No vault involvement.
- **Borrow/Repay**: treasury interaction, unrelated to vault.
- **Star**: 0.05 SOL from agent wallet. Trivial cost, no vault.

The vault is a **buy-only spending cap**. It does not custody tokens. Tokens always go to the buyer's wallet.

---

## Token Lifecycle

The SDK covers the full token lifecycle on the Torch Market protocol:

```
CREATE → BONDING → COMPLETE → MIGRATE → DEX TRADING
   │         │                    │           │
   │    buy/sell on curve    vote finalizes   borrow/repay
   │    (vault-funded buys)                  (treasury lending)
   │
   └── star token (appreciation signal, 0.05 SOL)
```

### Bonding Phase (0–200 SOL)

- `buildBuyTransaction` — buy tokens on the bonding curve
- `buildSellTransaction` — sell tokens back to the curve
- `getBuyQuote` / `getSellQuote` — simulate trades
- Fee split: 1% protocol fee, 1% treasury fee, 98% to curve+treasury (dynamic)

### Post-Migration

- Tokens trade on Raydium DEX (not through the SDK)
- `buildBorrowTransaction` — lock tokens as collateral, borrow SOL from treasury
- `buildRepayTransaction` — repay SOL debt, recover collateral
- `buildLiquidateTransaction` — liquidate underwater positions (permissionless)

### Community Features

- `buildStarTransaction` — star a token (0.05 SOL, sybil-resistant)
- `getMessages` — read trade-bundled memos (SPL Memo program)
- Vote on first buy (`vote` param in `buildBuyTransaction`)

---

## Quote Engine

The SDK includes a local quote engine that mirrors the on-chain math exactly:

### Buy Quote

```
1. Protocol fee: 1% of input SOL
2. Treasury fee: 1% of input SOL
3. Dynamic treasury split: 20% → 5% (decays as bonding progresses)
4. Remaining SOL → constant product formula → tokens out
5. Token split: 90% to buyer, 10% to community treasury
```

### Sell Quote

```
1. Constant product formula → SOL out
2. No sell fee (0%)
3. Full SOL amount to seller
```

### Constant Product Formula

```
tokens_out = (virtual_token_reserves × sol_in) / (virtual_sol_reserves + sol_in)
sol_out    = (virtual_sol_reserves × token_in) / (virtual_token_reserves + token_in)
price      = virtual_sol_reserves / virtual_token_reserves
```

---

## SAID Protocol Integration

The SDK integrates with the SAID (Solana Agent Identity) Protocol for wallet reputation:

- `verifySaid(wallet)` — check verification status and trust tier
- `confirmTransaction(connection, signature, wallet)` — confirm a transaction on-chain and determine its event type for reputation tracking

Event types: `token_launch`, `trade_complete`, `governance_vote`, `unknown`

SAID verification data enriches token detail responses (`creator_verified`, `creator_trust_tier`, `creator_said_name`, `creator_badge_url`) and message responses (`sender_verified`, `sender_trust_tier`).

---

## On-Chain Data Access

### Account Discovery

Tokens are discovered via `getProgramAccounts` with a BondingCurve discriminator filter (`4y6pru6YvC7` base58). This returns all bonding curve accounts. The SDK decodes them with Anchor's BorshCoder, filters out blacklisted/reclaimed tokens, and applies sorting/pagination locally.

### PDA Derivation

All PDAs are deterministic. The SDK derives them locally without RPC calls:

| Account | Seeds |
|---------|-------|
| GlobalConfig | `["global_config"]` |
| BondingCurve | `["bonding_curve", mint]` |
| Treasury | `["treasury", mint]` |
| UserPosition | `["user_position", bonding_curve, user]` |
| UserStats | `["user_stats", user]` |
| ProtocolTreasury | `["protocol_treasury_v11"]` |
| StarRecord | `["star_record", user, mint]` |
| LoanPosition | `["loan", mint, user]` |
| CollateralVault | `["collateral_vault", mint]` |
| TorchVault | `["torch_vault", creator]` |
| VaultWalletLink | `["vault_wallet", wallet]` |

### Raydium CPMM PDAs

For post-migration operations (borrow, liquidate), the SDK derives Raydium pool accounts:

| Account | Seeds (under Raydium CPMM program) |
|---------|-------------------------------------|
| Authority | `["vault_and_lp_mint_auth_seed"]` |
| PoolState | `["pool", amm_config, token0, token1]` |
| LP Mint | `["pool_lp_mint", pool_state]` |
| Vault | `["pool_vault", pool_state, token_mint]` |
| Observation | `["observation", pool_state]` |

Token ordering follows Raydium convention: `token0 < token1` by pubkey bytes.

---

## Token Metadata

Token metadata (name, symbol, URI) is stored on-chain in the BondingCurve account as fixed-size byte arrays. The SDK decodes these with `Buffer.from(bytes).toString('utf8').replace(/\0/g, '')`.

For detailed token views (`getToken`), the SDK fetches the metadata URI to get description, image, and social links. The Irys gateway URL is automatically converted to the uploader URL as a fallback for SSL issues.

---

## Error Handling

The SDK throws standard JavaScript errors with descriptive messages:

- `Token not found: {mint}` — no bonding curve account for this mint
- `Bonding curve complete, trade on DEX` — buy/sell after migration
- `Cannot star your own token` — self-star prevention
- `Already starred this token` — duplicate star prevention
- `Token not yet migrated, lending not available` — borrow before migration

Transaction builders validate inputs locally before constructing the transaction. On-chain errors are returned by the RPC on submission and are not caught by the SDK.

---

## Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `PROGRAM_ID` | `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT` | Torch Market program |
| `TOTAL_SUPPLY` | 1,000,000,000 (1B × 10^6) | Token supply with 6 decimals |
| `TOKEN_DECIMALS` | 6 | SPL token decimals |
| `RAYDIUM_CPMM_PROGRAM` | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Raydium CPMM |
| `RAYDIUM_AMM_CONFIG` | `D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2` | 0.25% fee tier |
| `TOKEN_2022_PROGRAM_ID` | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | Token Extensions |
| `MEMO_PROGRAM_ID` | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | SPL Memo |

---

## E2E Test Coverage

The SDK includes a comprehensive end-to-end test that runs against a Surfpool mainnet fork:

| Test | What It Validates |
|------|-------------------|
| Create Token | Token-2022 mint + bonding curve + treasury initialized |
| Create Vault | TorchVault PDA + auto-linked creator wallet |
| Deposit Vault | SOL transferred into vault escrow |
| Query Vault | `getVault`, `getVaultForWallet`, `getVaultWalletLink` |
| Get Token | On-chain metadata decoding, status, progress |
| List Tokens | Discriminator filtering, sort, pagination |
| Buy (direct) | Standard buy without vault (backward compat) |
| Buy (via vault) | Vault-funded buy, vault balance decreases |
| Link + Vault Buy | Agent wallet linked, buys via vault, then unlinked |
| Withdraw Vault | Authority withdraws remaining SOL |
| Sell | Sell tokens back to curve |
| Star | Sybil-resistant appreciation signal |
| Messages | Trade-bundled SPL Memo retrieval |
| Confirm | SAID Protocol transaction confirmation |
| Full Lifecycle | Bond to 200 SOL → migrate to Raydium → borrow → repay |

Expected result: **22 passed, 0 failed**

---

## Version History

| Version | Changes |
|---------|---------|
| 1.0.0 | Initial SDK: tokens, quotes, buy/sell/create/star, SAID, messages |
| 1.0.1–1.0.5 | Bug fixes, lending support, discriminator filtering |
| 2.0.0 | **Torch Vault integration.** 6 new vault builders, 3 vault queries, vault-funded buy. IDL updated to v3.0.0. Breaking change: BuyParams accepts optional `vault` field. |
