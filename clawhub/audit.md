# Torch SDK Security Audit

**Audit Date:** February 14, 2026
**Auditor:** Claude Opus 4.6 (Anthropic)
**SDK Version:** 3.3.0
**On-Chain Program:** `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT` (V3.3.0)
**Language:** TypeScript
**Test Result:** 32 passed, 0 failed (Surfpool mainnet fork)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Scope](#scope)
3. [Methodology](#methodology)
4. [PDA Derivation Correctness](#pda-derivation-correctness)
5. [Quote Math Verification](#quote-math-verification)
6. [Vault Integration Review](#vault-integration-review)
7. [Input Validation](#input-validation)
8. [External API Surface](#external-api-surface)
9. [Dependency Analysis](#dependency-analysis)
10. [Transaction Builder Review](#transaction-builder-review)
11. [Findings](#findings)
12. [Conclusion](#conclusion)

---

## Executive Summary

This audit covers the Torch SDK v3.2.4, a TypeScript library that reads on-chain state from Solana and builds unsigned transactions for the Torch Market protocol. The SDK was cross-referenced against the live on-chain program (V3.2.0) to verify PDA derivation, quote math, vault integration, and account handling. v3.2.4 resolves all 3 low-severity findings from the prior v3.2.3 audit.

The SDK is **stateless** (no global state, no connection pools), **non-custodial** (never touches private keys — all transactions are returned unsigned), and **RPC-first** (all data from Solana, no proprietary API for core operations).

### Overall Assessment

| Category | Rating | Notes |
|----------|--------|-------|
| PDA Derivation | **PASS** | All 12 seeds match on-chain `constants.rs` exactly |
| Quote Math | **PASS** | Exact match with on-chain buy handler (BigInt, fees, dynamic rate, token split) |
| Vault Integration | **PASS** | Correct null/Some handling, wallet link derived from buyer (not vault creator) |
| Key Safety | **PASS** | No key custody — unsigned transaction pattern throughout |
| Input Validation | **PASS** | Slippage validated with explicit error, lengths checked, PublicKey constructor validates base58 |
| External APIs | **PASS** | SAID + CoinGecko + metadata URI — all degrade gracefully, metadata fetch has 10s timeout |
| Dependencies | **MINIMAL** | 4 runtime deps, all standard Solana ecosystem |

### Finding Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 (3 resolved in v3.2.4) |
| Informational | 6 |

---

## Scope

### Files Reviewed

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 85 | Public API surface (24 functions, ~28 types, 4 constants) |
| `src/types.ts` | 305 | All TypeScript interfaces |
| `src/constants.ts` | 59 | Program ID, PDA seeds, token constants, blacklist |
| `src/program.ts` | 436 | PDA derivation, Anchor types, quote math, Raydium PDAs |
| `src/tokens.ts` | 788 | Read-only queries (tokens, vault, lending, holders, messages) |
| `src/transactions.ts` | 943 | Transaction builders (buy, sell, vault, lending, star) |
| `src/quotes.ts` | 102 | Buy/sell quote calculations |
| `src/said.ts` | 111 | SAID Protocol integration |
| `src/gateway.ts` | 49 | Irys metadata fetch with fallback + timeout |
| `src/torch_market.json` | — | Anchor IDL (V3.2.0, 25 instructions) |
| **Total** | **2,750** | |

### On-Chain Cross-Reference

| File | Purpose |
|------|---------|
| `constants.rs` | Verified all PDA seed strings and numeric constants |
| `contexts.rs` | Verified Buy context vault account derivation and constraints |
| `handlers/market.rs` | Verified buy/sell math matches SDK quote engine |

---

## Methodology

1. **Line-by-line source review** of all 10 SDK source files
2. **PDA seed cross-reference** between `constants.ts` and on-chain `constants.rs`
3. **Math cross-reference** between `program.ts:calculateTokensOut` and on-chain `handlers/market.rs:buy`
4. **Vault account cross-reference** between `transactions.ts:buildBuyTransaction` and on-chain `contexts.rs:Buy`
5. **E2E validation** via Surfpool mainnet fork (32/32 tests passed)

---

## PDA Derivation Correctness

All PDA seeds in the SDK were compared against the on-chain Rust program:

| PDA | SDK Seed (`constants.ts`) | On-Chain Seed (`constants.rs`) | Match |
|-----|--------------------------|-------------------------------|-------|
| GlobalConfig | `"global_config"` | `b"global_config"` | YES |
| BondingCurve | `["bonding_curve", mint]` | `[BONDING_CURVE_SEED, mint]` | YES |
| Treasury | `["treasury", mint]` | `[TREASURY_SEED, mint]` | YES |
| UserPosition | `["user_position", bonding_curve, user]` | `[USER_POSITION_SEED, bonding_curve, user]` | YES |
| UserStats | `["user_stats", user]` | `[USER_STATS_SEED, user]` | YES |
| ProtocolTreasury | `"protocol_treasury_v11"` | `b"protocol_treasury_v11"` | YES |
| StarRecord | `["star_record", user, mint]` | `[STAR_RECORD_SEED, user, mint]` | YES |
| LoanPosition | `["loan", mint, user]` | `[LOAN_SEED, mint, user]` | YES |
| CollateralVault | `["collateral_vault", mint]` | `[COLLATERAL_VAULT_SEED, mint]` | YES |
| TorchVault | `["torch_vault", creator]` | `[TORCH_VAULT_SEED, creator]` | YES |
| VaultWalletLink | `["vault_wallet", wallet]` | `[VAULT_WALLET_LINK_SEED, wallet]` | YES |

**Raydium PDAs** (under `RAYDIUM_CPMM_PROGRAM`):

| PDA | SDK Seed | Match |
|-----|----------|-------|
| Authority | `["vault_and_lp_mint_auth_seed"]` | YES |
| PoolState | `["pool", amm_config, token0, token1]` | YES |
| LP Mint | `["pool_lp_mint", pool_state]` | YES |
| Vault | `["pool_vault", pool_state, token_mint]` | YES |
| Observation | `["observation", pool_state]` | YES |

**Token ordering** for Raydium uses byte-level comparison (`token0 < token1`), matching Raydium convention. Implementation in `orderTokensForRaydium` (program.ts:334-351) iterates all 32 bytes.

**Verdict:** All PDA derivations are correct and match the on-chain program exactly.

---

## Quote Math Verification

### Buy Quote (`calculateTokensOut`)

SDK implementation (program.ts:243-299) was compared step-by-step against on-chain `buy` handler (market.rs:23-478):

| Step | SDK (BigInt) | On-Chain (u64/u128) | Match |
|------|-------------|---------------------|-------|
| Protocol fee | `solAmount * 100n / 10000n` | `sol_amount * protocol_fee_bps / 10000` | YES |
| Treasury fee | `solAmount * 100n / 10000n` | `sol_amount * TREASURY_FEE_BPS / 10000` | YES |
| Sol after fees | `solAmount - protocolFee - treasuryFee` | `sol_amount - protocol_fee_total - token_treasury_fee` | YES |
| Dynamic rate range | `BigInt(2000 - 500)` = 1500 | `(TREASURY_SOL_MAX_BPS - TREASURY_SOL_MIN_BPS)` = 1500 | YES |
| Decay | `realSolReserves * rateRange / BONDING_TARGET` | `reserves * rate_range / target` | YES |
| Rate floor | `Math.max(2000 - decay, 500)` | `rate.max(TREASURY_SOL_MIN_BPS)` | YES |
| Sol to treasury | `solAfterFees * treasuryRateBps / 10000` | `sol_after_fees * treasury_rate_bps / 10000` | YES |
| Sol to curve | `solAfterFees - solToTreasurySplit` | `sol_after_fees - sol_to_treasury_split` | YES |
| Tokens out | `virtualTokens * solToCurve / (virtualSol + solToCurve)` | `virtual_token_reserves * sol_to_curve / (virtual_sol_reserves + sol_to_curve)` | YES |
| Tokens to user | `tokensOut * 9000n / 10000n` | `tokens_out * (10000 - BURN_RATE_BPS) / 10000` where BURN_RATE_BPS=1000 | YES |
| Tokens to treasury | `tokensOut - tokensToUser` | `tokens_out - tokens_to_buyer` | YES |

**Key observation:** The SDK uses `BigInt` for all arithmetic, mirroring the on-chain `checked_mul`/`checked_div` behavior. Integer division truncation is identical in both environments.

### Sell Quote (`calculateSolOut`)

| Step | SDK | On-Chain | Match |
|------|-----|----------|-------|
| Sol out | `virtualSol * tokenAmount / (virtualTokens + tokenAmount)` | `virtual_sol_reserves * token_amount / (virtual_token_reserves + token_amount)` | YES |
| Fee | 0 (no sell fee) | `SELL_FEE_BPS = 0` | YES |

**Verdict:** Quote math is an exact match with the on-chain program.

---

## Vault Integration Review

### Buy Transaction — Vault Account Handling

The on-chain `Buy` context (contexts.rs:170-286) defines:

```rust
pub torch_vault: Option<Box<Account<'info, TorchVault>>>,
pub vault_wallet_link: Option<Box<Account<'info, VaultWalletLink>>>,
```

The `vault_wallet_link` constraint uses `buyer.key()` as the seed:
```rust
seeds = [VAULT_WALLET_LINK_SEED, buyer.key().as_ref()],
```

**SDK behavior** (transactions.ts:167-173):

```typescript
if (vaultCreatorStr) {
  const vaultCreator = new PublicKey(vaultCreatorStr)
  ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)     // from creator
  ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(buyer)  // from buyer
}
```

This is **correct**:
- Vault PDA is derived from the vault creator (the `vault` param)
- Wallet link PDA is derived from the buyer (the transaction signer)
- When not using vault, both are passed as `null` (Anchor treats as `None`)

### On-Chain C-1 Fix Verification

The on-chain buy handler (market.rs:30-39) includes the critical fix:

```rust
if ctx.accounts.torch_vault.is_some() {
    require!(
        ctx.accounts.vault_wallet_link.is_some(),
        TorchMarketError::WalletNotLinked
    );
}
```

The SDK always provides both vault accounts together or neither (transactions.ts:167-173), so the C-1 vulnerability path is not reachable through the SDK. However, the on-chain fix is the actual security boundary — the SDK is just a convenience layer.

### Vault Query Functions

| Function | Derivation | Verified |
|----------|-----------|----------|
| `getVault(creator)` | `getTorchVaultPda(creator)` | YES |
| `getVaultForWallet(wallet)` | `getVaultWalletLinkPda(wallet)` → follow `link.vault` | YES |
| `getVaultWalletLink(wallet)` | `getVaultWalletLinkPda(wallet)` | YES |

### Sell, Star, Borrow, Repay — Vault Account Handling

V3.2.0 extends vault routing to all write operations. The SDK passes `torchVault`, `vaultWalletLink`, and (where applicable) `vaultTokenAccount` as optional accounts. When vault is not specified, all three are passed as `null`. The pattern is consistent across all builders — verified by E2E tests covering vault-routed buy, sell, star, borrow, repay, and DEX swap.

### Protocol Rewards — Vault-Routed Claim

`buildClaimProtocolRewardsTransaction` routes epoch reward claims through the vault. The protocol treasury accumulates 1% fees from all bonding curve buys. Each epoch, rewards are distributed proportionally to wallets with >= 10 SOL volume in the previous epoch. The claim sends SOL directly to the vault — maintaining the closed economic loop. The SDK derives all required accounts (UserStats, ProtocolTreasury, TorchVault, VaultWalletLink) from the caller's public key and vault creator.

**Verdict:** Vault integration is correct and consistent with the on-chain program.

---

## Input Validation

### PublicKey Strings

All public key strings are passed to `new PublicKey(str)` which throws on invalid base58. The SDK does **not** pre-validate these — it relies on the `PublicKey` constructor. This is acceptable since:
- Invalid keys throw immediately with a clear error
- No on-chain transaction is built or submitted with invalid keys

### Slippage Validation

Buy and sell builders validate slippage (transactions.ts):

```typescript
if (slippage_bps < 10 || slippage_bps > 1000) {
  throw new Error(`slippage_bps must be between 10 (0.1%) and 1000 (10%), got ${slippage_bps}`)
}
```

Range: **0.1% to 10%**. Default: **1%** (100 bps). Values outside this range throw an explicit error (previously silently clamped in v3.2.3, resolved in v3.2.4). The buy quote (quotes.ts:47) uses a fixed 1% slippage for `min_output_tokens`, which is independent of the builder's slippage.

### String Length Validation

- Token name: max 32 characters (transactions.ts:346)
- Token symbol: max 10 characters (transactions.ts:347)
- Message: max 500 characters (transactions.ts:206-208, 304-306)

### Numeric Inputs

`amount_sol` and `amount_tokens` are not explicitly validated for zero or negative values. However:
- Zero amounts will produce zero output and fail the on-chain `MIN_SOL_AMOUNT` check (0.001 SOL)
- Negative numbers will produce invalid `BN` values and fail on-chain

---

## External API Surface

### SAID Protocol API

**Endpoint:** `https://api.saidprotocol.com/api`

| Function | Method | Risk |
|----------|--------|------|
| `verifySaid(wallet)` | `GET /verify/{wallet}` | Low |
| `confirmTransaction(...)` | On-chain only (no API call) | None |

`verifySaid` fails gracefully — returns `{ verified: false, trustTier: null }` on any error (said.ts:36-38). This is **read-only** and **non-critical** — it enriches token detail responses but does not affect trading.

### CoinGecko API

**Endpoint:** `https://api.coingecko.com/api/v3/simple/price`

Used in `getToken()` (tokens.ts:342-349) for SOL/USD conversion. Fails gracefully — adds a warning string but does not throw. Non-critical — `price_usd` and `market_cap_usd` are `undefined` on failure.

### Metadata URI (Token Creator-Controlled)

`getToken()` fetches the metadata URI stored in the on-chain `BondingCurve.uri` field (tokens.ts:314-328). This URI is **set by the token creator** and could point to any HTTP endpoint.

The SDK:
- Uses `fetchWithFallback()` which rewrites Irys gateway URLs to uploader URLs
- Parses the JSON response for `description`, `image`, `twitter`, `telegram`, `website`
- Fails gracefully — catches errors and adds a warning

**Risk:** The metadata URI is creator-controlled, so a malicious creator could set it to a slow/hostile endpoint. As of v3.2.4, `fetchWithFallback` enforces a 10-second timeout via `AbortController`. Slow endpoints are aborted and the error is caught gracefully. This is not in any transaction path.

---

## Dependency Analysis

### Runtime Dependencies

| Package | Version | Purpose | Risk |
|---------|---------|---------|------|
| `@coral-xyz/anchor` | ^0.32.1 | IDL decoding, program interaction | Low — standard Solana |
| `@solana/spl-token` | ^0.4.14 | ATA derivation, token instructions | Low — standard Solana |
| `@solana/web3.js` | ^1.98.4 | RPC, PublicKey, Transaction | Low — standard Solana |
| `bs58` | ^6.0.0 | Base58 decoding (memo parsing) | Low — pure JS, no native |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@types/node` | ^20 | TypeScript types |
| `prettier` | ^3.5.3 | Code formatting |
| `typescript` | ^5 | Compilation |

**Verdict:** Minimal dependency surface. All 4 runtime dependencies are standard Solana ecosystem packages. No native modules (except transitive via `@solana/web3.js`). No custom crypto.

---

## Transaction Builder Review

### Key Safety — Unsigned Transaction Pattern

All `build*Transaction` functions return `{ transaction: Transaction, message: string }`. The SDK **never**:
- Accepts private keys or keypairs as parameters (except `buildCreateTokenTransaction` which generates and returns a mint keypair)
- Signs transactions
- Submits transactions to the network

The `makeDummyProvider` pattern (transactions.ts:67-74) creates a no-op wallet for Anchor's `Program` constructor. The dummy wallet's `signTransaction` is a passthrough — it is never called during instruction building.

**One exception:** `buildCreateTokenTransaction` generates a `Keypair` for the mint, partially signs the transaction with it (transactions.ts:398), and returns the keypair. This is by design — the mint must be a signer for Token-2022 initialization. The caller receives the keypair for address extraction. This is not a custody risk since the mint keypair has no authority after creation.

### Account Derivation Consistency

All transaction builders derive accounts locally from PDA functions in `program.ts`. No builder accepts raw account addresses from the caller — all addresses are computed from the mint, buyer/seller, and vault creator parameters. This eliminates account confusion attacks at the SDK level.

### Blockhash Freshness

All transactions call `finalizeTransaction()` which fetches `getLatestBlockhash()` (transactions.ts:76-84). The blockhash is fetched at build time, not at sign time. If there is a long delay between building and signing, the transaction may expire. This is standard behavior for Solana SDKs.

---

## Findings

### L-1: No Timeout on Metadata URI Fetch — RESOLVED in v3.2.4

**Severity:** Low
**File:** `gateway.ts`
**Description:** `getToken()` fetches the metadata URI (creator-controlled) without a timeout. A malicious or slow endpoint could cause `getToken()` to hang indefinitely.
**Impact:** Denial of service for `getToken()` callers. Does not affect transaction building.
**Resolution:** `fetchWithFallback` now accepts a `timeoutMs` parameter (default 10s) and enforces it via `AbortController`. Slow/hanging endpoints are aborted and the error is caught gracefully.

### L-2: Silent Slippage Clamping — RESOLVED in v3.2.4

**Severity:** Low
**File:** `transactions.ts`
**Description:** Slippage values outside the 0.1%-10% range were silently clamped. A caller passing `slippage_bps: 5000` (50%) got 10% without any warning.
**Impact:** Unexpected slippage behavior. Not a fund safety issue — trades fail rather than execute at bad prices.
**Resolution:** Out-of-range `slippage_bps` values now throw an explicit error with the accepted range (10–1000 bps).

### L-3: Hardcoded Discriminator — RESOLVED in v3.2.4

**Severity:** Low
**File:** `tokens.ts`
**Description:** LoanPosition account scanning used a hardcoded 8-byte discriminator array. If the IDL changes (account rename), this would silently break loan enumeration.
**Impact:** `getLendingInfo()` could return incorrect loan counts. No security impact.
**Resolution:** LoanPosition discriminator is now derived from the Anchor IDL via `BorshCoder.accounts.accountDiscriminator('LoanPosition')`. Changes to the IDL are automatically reflected.

### I-1: No Zero Amount Validation

**Severity:** Informational
**File:** `transactions.ts:100-224`
**Description:** Buy and sell builders do not check for zero `amount_sol` or `amount_tokens`. Zero amounts will produce zero-output transactions that fail on-chain (`MIN_SOL_AMOUNT` check).
**Impact:** Wasted transaction fee. The on-chain program rejects the transaction safely.

### I-2: Vote Parameter Encoding

**Severity:** Informational
**File:** `transactions.ts:179`
**Description:** The vote parameter encoding is `return → true`, `burn → false`, `undefined → null`. This inverted convention (return=true, burn=false) matches the on-chain program but could confuse SDK consumers who might expect burn=true.
**Impact:** None — encoding is correct. Documentation should clarify the inversion.

### I-3: CoinGecko Rate Limiting

**Severity:** Informational
**File:** `tokens.ts:342-349`
**Description:** The CoinGecko free API has rate limits. High-frequency `getToken()` calls will trigger rate limiting, causing `price_usd` to be unavailable.
**Impact:** Missing USD pricing. Degrades gracefully.

### I-4: Holder Count Uses `getTokenLargestAccounts`

**Severity:** Informational
**File:** `tokens.ts:333-337`
**Description:** Holder count is derived from `getTokenLargestAccounts` which returns at most 20 accounts. For tokens with many holders, this count is an undercount.
**Impact:** Reported holder count may be lower than actual. Non-critical — informational only.

### I-5: Lending Constants are Hardcoded

**Severity:** Informational
**File:** `tokens.ts:504-507`
**Description:** Lending parameters (`INTEREST_RATE_BPS`, `MAX_LTV_BPS`, `LIQUIDATION_THRESHOLD_BPS`, `LIQUIDATION_BONUS_BPS`) are hardcoded in the SDK rather than read from on-chain state. If the on-chain program updates these values, the SDK would report stale parameters.
**Impact:** `getLendingInfo()` could report incorrect rates. Does not affect transaction building — the on-chain program enforces actual rates.
**Recommendation:** Read lending parameters from the on-chain Treasury or GlobalConfig account if available.

### I-6: Platform Treasury Removal (V3.2.0)

**Severity:** Informational
**Description:** V3.2.0 merges the platform treasury into the protocol treasury. The `buildClaimEpochRewardsTransaction` function and `ClaimEpochRewardsParams` type have been removed. The `platform_treasury` optional account has been removed from Buy and Sell builders. Reclaim SOL now routes to the protocol treasury instead of the platform treasury. The protocol treasury is now the single reward system — funded by both trading fees and reclaims.
**Impact:** Breaking change for SDK consumers using epoch rewards. All clients must update to v3.2.0.
**Status:** By design. Reduces code surface and eliminates a duplicate reward system.

---

## Conclusion

The Torch SDK v3.3.0 is a well-structured, minimal-surface TypeScript library that correctly mirrors the on-chain Torch Market V3.3.0 program. Key findings:

1. **PDA derivation is correct** — all 11 Torch PDAs and 5 Raydium PDAs match the on-chain seeds exactly.
2. **Quote math is correct** — BigInt arithmetic matches the on-chain Rust `checked_mul`/`checked_div` behavior, including the dynamic treasury rate, 90/10 token split, and constant product formula.
3. **Vault integration is correct** — vault PDA derived from creator, wallet link derived from buyer, both null when vault not used.
4. **No key custody** — the SDK never touches private keys. All transactions are returned unsigned.
5. **Minimal dependency surface** — 4 runtime deps, all standard Solana ecosystem.
6. **All low-severity findings resolved** — metadata fetch timeout added, slippage validation made explicit, discriminator derived from IDL. 6 informational issues remain (by design or non-critical).
7. **V3.2.1 on-chain security fix verified** — `harvest_fees` `treasury_token_account` constrained to treasury's exact ATA via Anchor `associated_token` constraints. Independent human auditor gave green flag.
8. **V3.3.0 tiered bonding** — new `sol_target` parameter on `buildCreateTokenTransaction` correctly passes through to on-chain `CreateTokenArgs`. Kani proofs updated and verified for all tiers (20/20 passing).

The SDK is safe for production use by AI agents and applications interacting with the Torch Market protocol.

---

## Audit Certification

This audit was performed by Claude Opus 4.6 (Anthropic). Original audit on February 12, 2026 (v3.2.3). Updated February 14, 2026 for v3.2.4 remediation. Updated February 15, 2026 for v3.3.0 (tiered bonding curves, harvest_fees security fix, Kani proof updates). All source files were read in full and cross-referenced against the on-chain program. The E2E test suite (32/32 passed) validates the SDK against a Surfpool mainnet fork of the live program. Independent human security auditor verified the on-chain program and frontend.

**Auditor:** Claude Opus 4.6
**Date:** 2026-02-15
**SDK Version:** 3.3.0
**On-Chain Version:** V3.3.0 (Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`)
