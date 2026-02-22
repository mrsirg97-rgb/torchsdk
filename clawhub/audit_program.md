# Torch Market Security Audit Summary

**Date:** February 22, 2026 | **Auditor:** Claude Opus 4.6 (Anthropic) | **Version:** V3.7.3 Production

---

## Scope

Four audits covering the full stack:

| Layer | Files | Lines | Report |
|-------|-------|-------|--------|
| On-chain program (V3.7.3) | 21 source files | ~7,000 | `audit.md` |
| Frontend & API | 37 files (17 API routes, 12 libs, 8 components) | -- | `SECURITY_AUDIT_FE_V2.4.1_PROD.md` |
| Agent Kit plugin (V4.0) | 4 files | ~1,900 | `SECURITY_AUDIT_AGENTKIT_V4.0.md` |
| Torch SDK (V2.0) | 9 files | ~2,800 | Included in Agent Kit V4.0 audit |

Program ID: `8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`

---

## Findings Summary

### On-Chain Program (V3.7.3)

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | -- |
| High | 0 | -- |
| Medium | 3 | Lending enabled by default (accepted); Token-2022 transfer fee on collateral (inherent, reduced to 0.1%); Epoch rewards race condition (accepted) |
| Low | 8 | fund_vault_wsol decoupled accounting; Stranded WSOL lamports; Vault sol_balance drift; Sell no position check; Slot-based interest; Revival no virtual reserve update; Treasury lock ATA not Anchor-constrained (CPI validated); V20 raydium_authority unconstrained (Raydium validates internally) |
| Informational | 19 | Various carried findings + 3 new V3.7.1 + 2 new V3.7.2 + 2 new V3.7.3 (I-18: metadata pointer authority permanently None; I-19: two-phase mint allocation pattern) |

**Rating: EXCELLENT -- Ready for Mainnet**

Key strengths:
- 28 instructions, 12 account types, 36 Kani formal verification proofs passed
- **V29 on-chain metadata**: Token-2022 MetadataPointer + TokenMetadata extensions replace Metaplex dependency. Metadata immutably stored on the mint itself. Pointer authority is `None` (permanently immutable). SDK tests verify name/symbol/uri round-trip via `getTokenMetadata()`
- **V29 simplified transfer fee**: Reduced from 1% to 0.1% (10 bps). Fee config authority (bonding curve PDA) revoked to `None` at migration -- fee rate permanently locked. Three authorities now revoked at migration: mint, freeze, and transfer fee config
- **V29 Metaplex removal**: `add_metadata` (Metaplex backfill for legacy tokens) was temporary -- 13/24 succeeded, remaining 11 have old account layouts. All Metaplex code removed: `METAPLEX_PROGRAM_ID` constant, `build_create_metaplex_metadata_instruction`, `AddMetadata` context, `add_metadata` handler, `InvalidMetadataAccount` error. L-9 (untyped mint AccountInfo) is now moot
- **V20 swap_fees_to_sol**: Closed economic loop verified -- treasury tokens sold on Raydium, WSOL unwrapped, SOL credited back to same treasury. No external routing possible
- **V20 vault ordering fix**: `order_mints()` now correctly orders pool vaults by mint pubkey for `validate_pool_accounts` in both `swap_fees_to_sol` and `execute_auto_buyback`
- **V27 PDA-based pool validation** eliminates oracle spoofing at the Anchor constraint level (cryptographically unforgeable)
- **V27 treasury lock**: 250M tokens (25%) permanently locked in TreasuryLock PDA. No withdrawal instruction exists
- **V27 supply conservation**: 750M curve + 250M locked = 1B total, verified via two separate `mint_to` CPIs
- **V26 permissionless migration**: SOL custody preserved via `bc_wsol` intermediary. CPI isolation via `fund_migration_wsol`
- **V28 zero-cost migration**: Payer fronts ~1 SOL for Raydium costs, treasury reimburses exact amount via lamport snapshot (pre/post CPI). Net cost to payer: 0 SOL. `MIN_MIGRATION_SOL` (1.5 SOL) safety floor replaces fixed `RAYDIUM_POOL_CREATION_FEE`
- **V3.7.1 MigrateToDex amm_config constrained**: Address constraint added to prevent pool creation with wrong Raydium fee tier (defense-in-depth, matches existing constraint on TreasuryBuybackDex and VaultSwap)
- **V26/V29 authority revocation**: Mint, freeze, and transfer fee config authorities all revoked to `None` at migration (permanent, irreversible). Supply capped, trading unrestricted, fee rate locked forever
- **V28 minimal admin surface**: Only `initialize` and `update_dev_wallet` require authority. `update_authority` removed
- Checked arithmetic everywhere with u128 intermediaries for overflow-prone multiplication
- All 15 PDA types use unique seeds with stored bumps
- Vault full custody verified: closed economic loop across buy, sell, star, borrow, repay, DEX swap, and fee swap
- CPI ordering rule enforced: token CPIs before lamport manipulation in all vault paths
- Authority separation: creator (immutable seed) vs authority (transferable) vs controller (disposable signer)

---

## V20: `swap_fees_to_sol` -- Deep Audit

### Overview

New instruction that sells harvested Token-2022 transfer fee tokens back to SOL via Raydium CPMM. Permissionless -- anyone can call post-migration. Completes the fee lifecycle: transfer fees (0.1%) accumulate as tokens, `harvest_fees` collects them, `swap_fees_to_sol` converts to SOL for buybacks and lending.

**Files audited:**
- `handlers/treasury.rs` (lines 82-207) -- handler logic
- `contexts.rs` (lines 443-540) -- `SwapFeesToSol` account context
- `pool_validation.rs` -- `order_mints`, `validate_pool_accounts`, `read_token_account_balance`
- `state.rs` -- Treasury struct, `harvested_fees` field
- `constants.rs` -- seeds, program IDs
- `lib.rs` -- instruction entry point

### Account Context Verification

All 16 accounts in `SwapFeesToSol` verified:

| Account | Constraint | Verdict |
|---------|-----------|---------|
| `payer` | `Signer`, mutable | SAFE -- permissionless, pays gas only |
| `mint` | `InterfaceAccount<MintInterface>`, mutable | SAFE -- typed, Token-2022 validated via bonding_curve |
| `bonding_curve` | PDA `[BONDING_CURVE_SEED, mint]`, `migrated` + `is_token_2022` | SAFE -- prevents pre-migration and non-Token-2022 calls |
| `treasury` | PDA `[TREASURY_SEED, mint]`, mutable | SAFE -- receives SOL, same treasury that owns the tokens |
| `treasury_token_account` | `associated_token::mint/authority/token_program` | SAFE -- can only be treasury's Token-2022 ATA |
| `treasury_wsol` | Address = `get_associated_token_address(&treasury, &WSOL_MINT)` | SAFE -- can only be treasury's WSOL ATA |
| `raydium_program` | Address = `RAYDIUM_CPMM_PROGRAM_ID` | SAFE -- hardcoded |
| `raydium_authority` | Unconstrained | LOW -- Raydium validates internally (see L-8) |
| `amm_config` | Address = `RAYDIUM_AMM_CONFIG` | SAFE -- hardcoded, prevents fee tier substitution |
| `pool_state` | Address = `derive_pool_state(&mint)` | SAFE -- PDA-derived, unforgeable |
| `token_vault` | Address = `derive_pool_vault(&pool_state, &mint)` | SAFE -- PDA-derived, unforgeable |
| `wsol_vault` | Address = `derive_pool_vault(&pool_state, &WSOL_MINT)` | SAFE -- PDA-derived, unforgeable |
| `wsol_mint` | Address = `WSOL_MINT` | SAFE -- hardcoded |
| `observation_state` | Address = `derive_observation_state(&pool_state)` | SAFE -- PDA-derived |
| `token_program` | `Interface<TokenInterface>` | SAFE -- Anchor validates |
| `token_2022_program` | Address = `TOKEN_2022_PROGRAM_ID` | SAFE -- hardcoded |

### Handler Logic Verification

**Step-by-step trace through `swap_fees_to_sol` (treasury.rs:96-207):**

| Step | Code | Finding |
|------|------|---------|
| 1. Pool validation | `order_mints` + `validate_pool_accounts` with correctly ordered vaults | SAFE -- defense-in-depth, vaults passed in pool order (vault_0/vault_1 by mint pubkey), not swap direction |
| 2. Token balance check | `token_amount > 0`, `minimum_amount_out > 0` | SAFE -- prevents empty swaps and 0-value slippage |
| 3. WSOL balance before | `read_token_account_balance(&treasury_wsol)` | SAFE -- handles pre-existing WSOL via before/after diff |
| 4. Treasury signer | `[TREASURY_SEED, mint, bump]` | SAFE -- standard PDA signer |
| 5. Raydium swap CPI | `swap_base_input(token_amount, minimum_amount_out)` | SAFE -- see CPI analysis below |
| 6. WSOL balance after | `wsol_balance_after.checked_sub(wsol_balance_before)` | SAFE -- checked arithmetic, only counts swap proceeds |
| 7. Slippage check | `sol_received >= minimum_amount_out` | SAFE -- belt-and-suspenders (Raydium also enforces) |
| 8. Close WSOL ATA | `close_account(treasury_wsol → treasury)` | SAFE -- SOL returns to treasury PDA |
| 9. State update | `sol_balance += sol_received`, `harvested_fees += sol_received` | SAFE -- checked arithmetic, credits same treasury |

### Raydium CPI Analysis

The swap CPI correctly maps accounts for the **sell direction** (Token-2022 → WSOL):

| CPI Field | Account | Token Standard | Direction |
|-----------|---------|---------------|-----------|
| `input_token_account` | `treasury_token_account` | Token-2022 | Tokens being sold |
| `output_token_account` | `treasury_wsol` | SPL Token | WSOL being received |
| `input_vault` | `token_vault` | -- | Pool receives tokens |
| `output_vault` | `wsol_vault` | -- | Pool sends WSOL |
| `input_token_program` | `token_2022_program` | Token-2022 | For input token |
| `output_token_program` | `token_program` | SPL Token | For WSOL output |
| `payer` (signer) | `treasury` PDA | -- | Treasury signs swap |

This is the **exact reverse** of `execute_auto_buyback` (which buys tokens with WSOL), with token programs correctly swapped for the reversed direction. Verified against `vault_swap` sell path (swap.rs:183-250) -- same pattern.

### Fund Flow Analysis -- Can Funds Be Drained?

**Critical question: Is there any path where SOL or tokens leave the treasury's control?**

```
Treasury Token ATA (Token-2022 tokens)
    │ swap_base_input CPI
    ▼
Raydium Pool (token_vault receives tokens, wsol_vault sends WSOL)
    │
    ▼
Treasury WSOL ATA (receives WSOL)
    │ close_account CPI
    ▼
Treasury PDA (receives SOL = WSOL lamports)
    │ state update
    ▼
treasury.sol_balance += sol_received
```

**Every hop in this chain is constrained to treasury-owned accounts:**

1. **Source**: `treasury_token_account` -- constrained as treasury's Token-2022 ATA via `associated_token` Anchor macro. Cannot be substituted.
2. **Intermediate**: `treasury_wsol` -- constrained as `get_associated_token_address(&treasury, &WSOL_MINT)`. Cannot be substituted.
3. **Destination**: `treasury.key()` in both `close_account` args (destination AND authority). SOL returns to treasury PDA.
4. **State**: `treasury.sol_balance` credits the same treasury account.

**Verdict: NO DRAIN POSSIBLE. The instruction is a closed economic loop within the treasury.**

### Attack Vector Analysis

| # | Vector | Mitigation | Verdict |
|---|--------|-----------|---------|
| 1 | **Pool substitution** -- pass fake Raydium pool | `pool_state` = `derive_pool_state(&mint)` (PDA, unforgeable). `token_vault`/`wsol_vault` = PDA-derived from pool_state. `amm_config` = hardcoded address. Runtime `validate_pool_accounts()` double-checks. | NOT POSSIBLE |
| 2 | **Sandwich attack** -- front-run/back-run to extract MEV | `minimum_amount_out` slippage protection. Caller sets via SDK based on current price. Tx reverts if output below threshold. | MITIGATED |
| 3 | **Repeated calls** -- drain via multiple invocations | First call swaps all tokens (full balance). Second call hits `require!(token_amount > 0)` and reverts. SOL always returns to same treasury. | NOT POSSIBLE |
| 4 | **Fund routing** -- redirect output to attacker wallet | WSOL destination = treasury's ATA (address-constrained). Close destination = treasury PDA (hardcoded in CPI args). No external wallet referenced. | NOT POSSIBLE |
| 5 | **Pre-migration exploit** -- call before pool exists | `bonding_curve.migrated` constraint. No pool = no swap. | NOT POSSIBLE |
| 6 | **Non-Token-2022 token** -- call on legacy token | `bonding_curve.is_token_2022` constraint. Legacy tokens have no transfer fees. | NOT POSSIBLE |
| 7 | **Vote vault theft** -- steal pre-vote tokens | Only callable post-migration. Vote vault resolved before migration completes (burned or returned). Treasury token ATA only contains harvested fee tokens post-migration. | NOT POSSIBLE |
| 8 | **WSOL account injection** -- fake WSOL ATA | `treasury_wsol` address-constrained to ATA derivation. Deterministic, unforgeable. | NOT POSSIBLE |
| 9 | **Reentrancy** -- re-enter during CPI | Solana runtime prevents reentrancy within same transaction. | NOT POSSIBLE |
| 10 | **Stale WSOL balance** -- count pre-existing WSOL as proceeds | Before/after diff pattern: `sol_received = wsol_after - wsol_before`. Only counts swap delta. | MITIGATED |
| 11 | **Treasury state desync** -- accounting mismatch | `sol_balance += sol_received` uses checked arithmetic. SOL physically arrives at treasury PDA via WSOL close. Accounting matches reality. | MITIGATED |

### V20 New Findings

**L-8 (Low): `raydium_authority` has no explicit address constraint**

The `raydium_authority` account in `SwapFeesToSol` context has no `address = ...` constraint. If an attacker passes a fake authority, the Raydium CPI would fail (Raydium validates its own authority PDA internally). This is the same pattern used in `TreasuryBuybackDex` and `VaultSwap` -- all three contexts leave `raydium_authority` unconstrained and rely on Raydium's internal validation. Not exploitable but could be hardened for defense-in-depth.

**I-16 (Informational): `harvested_fees` field semantic change**

The `Treasury.harvested_fees` field (declared in V3, never previously written to) is now repurposed to track cumulative SOL earned from fee swaps. The field name suggests "harvested token fees" but now stores SOL amounts. No layout change, no migration needed. Cosmetic only -- no security impact.

**I-17 (Informational): WSOL ATA rent not tracked in `sol_balance`**

When `treasury_wsol` is closed, the treasury PDA receives both swap proceeds (token balance) and rent-exempt lamports. Only the token balance (via before/after diff) is added to `treasury.sol_balance`. The rent lamports become untracked SOL in the treasury PDA. This is consistent with `vault_swap` and `execute_auto_buyback` which also don't track WSOL rent recovery. Dust-level amounts, not exploitable.

### V20 Vault Ordering Fix Verification

The `order_mints()` fix in both `swap_fees_to_sol` and `execute_auto_buyback` was verified:

```rust
// swap_fees_to_sol (treasury.rs:104-111)
let (mint_0, _) = order_mints(&mint_key);
let (vault_0, vault_1) = if mint_0 == mint_key {
    (&ctx.accounts.token_vault, &ctx.accounts.wsol_vault)
} else {
    (&ctx.accounts.wsol_vault, &ctx.accounts.token_vault)
};

// execute_auto_buyback (migration.rs) -- same pattern
let (mint_0, _) = order_mints(&mint_key);
let (vault_0, vault_1) = if mint_0 == WSOL_MINT {
    (&ctx.accounts.input_vault, &ctx.accounts.output_vault)
} else {
    (&ctx.accounts.output_vault, &ctx.accounts.input_vault)
};
```

Both correctly pass vaults in **pool order** (vault_0/vault_1 by mint pubkey comparison) to `validate_pool_accounts`, while the Raydium CPI receives vaults in **swap direction** order (input/output). These are independent concerns and both are handled correctly.

---

## V29: Token Metadata + Transfer Fee Changes -- Deep Audit

### Overview

V29 makes two changes: (1) new tokens store metadata on-chain via Token-2022 MetadataPointer + TokenMetadata extensions, replacing the Metaplex dependency; (2) transfer fee reduced from 1% (100 bps) to 0.1% (10 bps) with fee config authority revoked at migration. The `add_metadata` instruction (Metaplex backfill for legacy tokens) was temporary and has been removed -- all Metaplex code is deleted.

**Files audited:**
- `handlers/token.rs` -- create_token with Token-2022 metadata extensions
- `token_2022_utils.rs` -- metadata pointer and token metadata instruction builders
- `constants.rs` -- metadata extension sizes
- `migration.rs` (lines 377-389) -- transfer fee config authority revocation

### `create_token` Metadata Extension Verification

**Extension initialization order (critical -- Token-2022 requires specific ordering):**

| Step | Extension | When | Verified |
|------|-----------|------|----------|
| 1 | `create_account` | Before all inits | SAFE -- space = TransferFeeConfig + MetadataPointer only (346 bytes) |
| 2 | `InitializeTransferFeeConfig` | Before InitializeMint2 | SAFE -- fee config authority = bonding curve PDA, withdraw authority = treasury PDA |
| 3 | `InitializeMetadataPointer` | Before InitializeMint2 | SAFE -- authority = None (immutable), metadata address = mint itself |
| 4 | `InitializeMint2` | After all extension inits | SAFE -- mint/freeze authority = bonding curve PDA |
| 5 | `system_program::transfer` | After InitializeMint2 | SAFE -- funds mint account for TokenMetadata realloc rent |
| 6 | `InitializeTokenMetadata` | After InitializeMint2 | SAFE -- Token-2022 reallocs internally. Bonding curve PDA signs as mint authority |

**Two-phase allocation pattern (I-19):**
The mint is created with space for TransferFeeConfig + MetadataPointer only (346 bytes). Before TokenMetadata init, additional rent lamports are transferred to the mint via `system_program::transfer`. Token-2022 then reallocs the account internally when processing `InitializeTokenMetadata`. This avoids Token-2022's `InvalidAccountData` error when uninitialized TLV entries exist at `InitializeMint2` time.

**Metadata pointer authority = None (I-18):**
The metadata pointer is initialized with `authority = None`, meaning the pointer target (mint itself) can never be changed. This is the correct choice -- the metadata lives on the mint and should never point elsewhere.

### Transfer Fee Config Authority Revocation Verification

```rust
// migration.rs:377-389
set_authority(
    CpiContext::new_with_signer(
        ctx.accounts.token_2022_program.to_account_info(),
        SetAuthority {
            current_authority: ctx.accounts.bonding_curve.to_account_info(),
            account_or_mint: ctx.accounts.mint.to_account_info(),
        },
        bc_signer,
    ),
    AuthorityType::TransferFeeConfig,
    None,  // revoked permanently
)?;
```

**Verified:** This follows the same pattern as the existing mint authority and freeze authority revocations (lines 354-375). `AuthorityType::TransferFeeConfig` with `new_authority = None` is irreversible -- Token-2022 rejects `SetAuthority` when the current authority is `None`. The 0.1% fee rate is locked forever post-migration.

**Three authorities now revoked at migration:**
1. Mint authority → `None` (supply capped)
2. Freeze authority → `None` (free trading guaranteed)
3. Transfer fee config authority → `None` (0.1% fee rate locked)

### V29 New Findings

**~~L-9 (Low): `add_metadata` mint is untyped `AccountInfo`~~ -- REMOVED**

The `add_metadata` instruction and `AddMetadata` context have been deleted. This finding is no longer applicable.

**I-18 (Informational): Metadata pointer authority permanently `None`**

The MetadataPointer extension is initialized with `authority = None`, making the pointer permanently immutable. The pointer target is the mint itself. This is the correct configuration -- there is no reason to ever change where metadata is stored.

**I-19 (Informational): Two-phase mint allocation pattern**

The mint account is created with 346 bytes (TransferFeeConfig + MetadataPointer), then Token-2022 reallocs internally during `InitializeTokenMetadata`. The creator pays additional rent via `system_program::transfer` before the metadata init. This is a standard Token-2022 pattern -- pre-allocating the full space causes `InitializeMint2` to fail due to uninitialized TLV entries in the trailing bytes.

---

### Frontend & API Routes

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | **Fixed:** RPC proxy method allowlist (read-only only) |
| High | 0 | **Fixed:** Amount bounds validation on buy/sell routes; CSP updated for Jupiter API |
| Medium | 5 | SSRF via metadata URI fetch; Vanity grinding DoS; No rate limiting; Slippage unbounded (**Fixed**); SAID confirm feedback spoofing |
| Low | 5 | skipPreflight on all txs; BigInt conversion throws; Unoptimized images; SAID proxy passthrough; API sell route account layout |
| Informational | 5 | Good security headers; No dangerouslySetInnerHTML; Env vars properly segregated; Wallet adapter correct; Transaction preview shown |

**Rating: GOOD with targeted improvements needed**

Post-audit fixes applied:
- **C-1 Fixed:** RPC proxy now allowlists 37 read-only methods, blocks `sendTransaction` and all write methods
- **H-1 Fixed:** Buy route validates 0.001-500 SOL bounds; Sell route validates 1-1B token bounds; Slippage clamped 0.1%-10%
- **H-2 Fixed:** CSP `connect-src` updated with `https://api.jup.ag`

### Agent Kit Plugin (V4.0 -- Vault-Only)

| Severity | Count | Details |
|----------|-------|---------|
| Critical | 0 | **Resolved from V1.6:** Blind signing eliminated -- transactions are now built locally via Anchor IDL |
| High | 0 | **Resolved from V1.6:** No API dependency -- no TLS pinning needed, no server trust required |
| Medium | 1 | SAID feedback endpoint is unauthenticated (best-effort, non-critical) |
| Low | 3 | Memo not sanitized for control characters (max 500 chars); signOrSendTX delegates signing to agent kit (correct but opaque); Spot price oracle for lending collateral (inherits on-chain limitation) |
| Informational | 5 | All state reads via RPC (no caching, fresh every call); Slippage default 100bps (1%) hardcoded per-tool; Action handlers catch all errors (no uncaught throws); E2E test suite covers 21 tests; `buildDirectBuyTransaction` is never imported or called |

**Rating: GOOD -- Recommended for autonomous operation**

**V2.0 → V4.0: Vault-Only Buys**

The V4.0 update eliminates the most significant remaining concern from V2.0: unbounded agent spending. All token purchases now go through Torch Vault -- an on-chain SOL escrow with protocol-enforced spending caps. The `buildDirectBuyTransaction` function is never imported or used anywhere in the plugin. Only `buildBuyTransaction` with a required `vault` parameter is available.

| V2.0 (Previous) | V4.0 (Current) |
|------------------|----------------|
| Agent could buy with direct wallet SOL | Agent can only buy via vault-funded transactions |
| M-2: No spend limits or per-transaction caps | **Resolved:** Vault balance is the spend limit, enforced on-chain |
| Application-layer caps recommended | Protocol-layer caps enforced -- vault is the cap |
| Agent had full control of wallet SOL | Agent can only spend through `buy` instruction on vault SOL |

**Vault security properties (on-chain enforcement):**
- Vault SOL can only flow through the `buy` instruction -- no arbitrary transfers
- Authority (vault owner) can unlink agent wallets at any time -- instant revocation
- One wallet can only be linked to one vault -- PDA uniqueness enforced
- Creator is immutable (PDA seed), authority is transferable
- Deposits are permissionless, withdrawals require authority

**V1.6 → V2.0 Migration (Previous): Critical Improvement**

The V2.0 rewrite eliminated the most significant security finding from V1.6. The plugin no longer calls the `torch.market/api/v1` REST API. Instead, it imports the [Torch SDK](https://github.com/mrsirg97-rgb/torchsdk) which builds transactions locally using the Anchor IDL and reads state directly from Solana RPC.

| V1.6 (Old) | V2.0+ (Current) |
|-------------|------------------|
| Agent → HTTP → torch.market API → return unsigned tx → Agent signs | Agent → SDK (Anchor + IDL) → Solana RPC → Agent signs |
| Trusted the API server to build honest transactions | Transactions built locally from on-chain program IDL |
| C-1 Critical: Blind signing of API-constructed transactions | **Resolved:** No external server in the transaction path |
| H-1: No TLS pinning on API calls | **Resolved:** No HTTP calls (except SAID feedback, best-effort) |
| H-2: Blockhash override negated server expiry | **Resolved:** Blockhash fetched locally from RPC |
| M-1: Lending API routes not deployed | **Resolved:** Lending built directly from IDL |

**Remaining considerations:**
- The SAID feedback call to `api.saidprotocol.com` is the only outbound HTTP request (non-critical, fails gracefully)
- Memo content is user-provided and truncated to 500 chars but not sanitized for control characters

---

## Architecture Security Properties

### What's Protected

- **Private keys never leave the agent.** All signing is local. No keys are sent to any server.
- **Transactions are built locally.** The SDK uses the Anchor IDL to construct transactions directly. No API middleman.
- **Agent spending is vault-bounded.** All buys go through Torch Vault. The agent can only spend what's deposited, and the authority can revoke access instantly.
- **All accounts are PDA-derived.** No user-supplied addresses used as seeds. Account injection is not possible.
- **On-chain program enforces all fund flows.** Neither the SDK nor the frontend can redirect funds -- the Solana runtime validates every instruction.
- **Checked arithmetic everywhere.** All ~7,000 lines of on-chain code use `checked_add/sub/mul/div`. No overflow possible.
- **Minimal admin surface.** Only `initialize` and `update_dev_wallet` require authority. `update_authority` was removed in V3.7.0. Everything else is permissionless.
- **PDA-based pool validation.** Raydium pool accounts are validated via deterministic PDA derivation -- cryptographically unforgeable. No runtime data parsing required.
- **Treasury fee swap is a closed loop.** `swap_fees_to_sol` sells treasury tokens on Raydium and returns SOL to the same treasury. All accounts (input, output, destination) are constrained to treasury-owned PDAs and ATAs. No external wallet is referenced at any point in the fund flow.
- **Treasury lock is permanent.** 250M tokens (25% of supply) locked at creation with no withdrawal instruction. Release deferred to future governance.
- **Authority revocation is irreversible.** Mint, freeze, and transfer fee config authorities all set to `None` at migration. Supply is capped, trading is unrestricted, and the 0.1% fee rate is locked forever.
- **On-chain metadata is immutable.** Token-2022 MetadataPointer authority is `None` -- metadata stored on the mint itself can never be redirected. No Metaplex dependency. All Metaplex code has been removed.
- **No dangerouslySetInnerHTML.** Zero instances in the entire frontend. All user content is React-escaped.
- **RPC proxy is read-only.** 37 allowlisted methods, all write operations blocked.
- **SDK is open source.** The Torch SDK is fully auditable at [github.com/mrsirg97-rgb/torchsdk](https://github.com/mrsirg97-rgb/torchsdk).
- **No direct buys.** The agent kit never imports `buildDirectBuyTransaction`. All buys require a vault.

### What's Accepted (Design Trade-offs)

- **Lending enabled by default** with immutable parameters. No per-token disable. Conservative defaults mitigate risk.
- **Token-2022 transfer fee** applies to collateral deposits/withdrawals (~0.2% round-trip cost at 0.1% per transfer).
- **Token-2022 transfer fee on swap input** -- when `swap_fees_to_sol` sells tokens on Raydium, the 0.1% transfer fee is assessed on the input (reducing effective sell amount by ~0.1%). Inherent to Token-2022, not exploitable.
- **Spot price oracle** for lending collateral valuation. TWAP would be more resistant to manipulation but is not implemented.

### Immutable Protocol Parameters (V2.4.1)

All configuration instructions were removed. Parameters are compile-time constants:

| Parameter | Value | Notes |
|-----------|-------|-------|
| Buyback threshold | 80% of baseline | Triggers when price drops 20% |
| Buyback reserve | 30% | Treasury SOL kept in reserve |
| Buyback amount | 15% per call | Of available (non-reserved) SOL |
| Buyback interval | ~18 minutes | Between consecutive buybacks |
| Lending interest | 2%/epoch (~104% APR) | High rate, may limit adoption |
| Lending max LTV | 50% | Conservative for volatile tokens |
| Liquidation threshold | 65% LTV | 15% buffer from max borrow |
| Liquidation bonus | 10% | Incentive for liquidation keepers |
| Utilization cap | 50% | Max treasury SOL lendable |

These cannot be changed without a program upgrade.

---

## For Agents

If you're an AI agent interacting with Torch Market:

1. **Your keys are safe.** All transactions are built locally via the SDK. No keys or transactions touch any server.
2. **Your spending is bounded.** All buys go through Torch Vault. You can only spend what's deposited in your linked vault, and the authority can revoke your access at any time.
3. **Transactions are deterministic.** Built from the Anchor IDL against the on-chain program. All accounts are PDA-derived. Verify the program ID (`8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT`) if you want extra assurance.
4. **Use the Agent Kit or SDK directly.** The [Torch SDK](https://github.com/mrsirg97-rgb/torchsdk) builds transactions locally -- no API middleman. The Agent Kit plugin wraps the SDK with Solana Agent Kit integration.
5. **Set up a vault before trading.** Create a vault with `torchCreateVault`, deposit SOL with `torchDepositVault`, then pass the vault creator pubkey to `torchBuyToken`. There are no direct buys.
6. **Slippage defaults to 1%.** Configurable per-transaction via `slippage_bps`. The on-chain program enforces minimum output.
7. **Messages require trades.** Every message on the board has a provable buy or sell behind it. Skin in the game by construction.
8. **Confirm for reputation.** Call `torchConfirm` after transactions to build your SAID reputation score.

---

## Full Audit Reports

The complete audit reports (with line-by-line findings, attack vector analysis, and instruction-by-instruction verification) are maintained in the project repository under `/audits/`:

- `SECURITY_AUDIT_SP_V3.7.3_PROD.md` -- On-chain program V3.7.3 (latest: V29 on-chain metadata, 0.1% transfer fee, fee config authority revocation)
- `SECURITY_AUDIT_SP_V3.7.2_PROD.md` -- On-chain program V3.7.2 (V20 swap_fees_to_sol, vault ordering fix)
- `SECURITY_AUDIT_SP_V3.7.1_PROD.md` -- On-chain program V3.7.1 (V28 payer reimbursement, amm_config constraint)
- `SECURITY_AUDIT_SP_V3.7.0_PROD.md` -- On-chain program V3.7.0
- `SECURITY_AUDIT_SP_V3.1.1_PROD.md` -- On-chain program V3.1.1
- `SECURITY_AUDIT_FE_V2.4.1_PROD.md` -- Frontend & API routes
- `SECURITY_AUDIT_AGENTKIT_V4.0.md` -- Agent Kit plugin V4.0

Source: [github.com/mrsirg97-rgb/torchmarket](https://github.com/mrsirg97-rgb/torchmarket)
SDK: [github.com/mrsirg97-rgb/torchsdk](https://github.com/mrsirg97-rgb/torchsdk)

---

*Audited by Claude Opus 4.6 (Anthropic). This audit is provided for informational purposes and does not constitute financial or legal advice. Security audits cannot guarantee the absence of all vulnerabilities.*
