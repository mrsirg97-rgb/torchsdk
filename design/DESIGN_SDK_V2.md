# SDK v2.0.0 — Torch Vault Integration

> Breaking change: all buys route through a Torch Vault.

## Context

The torch_market program v3.0.0 introduces the Torch Vault (DESIGN_V17). The SDK v2.0.0 makes the vault the primary interface for agent interaction.

**What changes:**
- Buys require a vault + wallet link (vault pays SOL, tokens go to buyer's wallet)
- 6 new vault lifecycle transaction builders
- New vault query functions
- IDL updated to v3.0.0

**What doesn't change:**
- Sell, borrow, repay, liquidate, star, create token — unchanged
- Quote calculations — unchanged
- Token listing/detail queries — unchanged
- SAID verification — unchanged

## Why Vault-Only for Buy

The vault is a **spending cap**. It controls how much SOL an agent can spend on buys.

- **Buy**: agent spends SOL → vault pays. This is the controlled operation.
- **Sell**: agent receives SOL → no vault needed. Agent holds tokens in its own wallet.
- **Borrow/Repay**: treasury interaction, not vault-related.

The agent wallet keeps a small SOL balance (~0.01 SOL) for transaction fees. The vault handles trade spend only.

## New Transaction Builders

| Builder | Signer | Description |
|---|---|---|
| `buildCreateVaultTransaction` | creator | Creates vault PDA + auto-links creator wallet |
| `buildDepositVaultTransaction` | depositor | Deposits SOL into any vault |
| `buildWithdrawVaultTransaction` | authority | Withdraws SOL to authority wallet |
| `buildLinkWalletTransaction` | authority | Links a wallet to the vault |
| `buildUnlinkWalletTransaction` | authority | Unlinks a wallet from the vault |
| `buildTransferAuthorityTransaction` | authority | Transfers vault admin control |

## Modified Transaction Builder

| Builder | Change |
|---|---|
| `buildBuyTransaction` | Accepts optional `vault` param. When provided, includes torchVault + vaultWalletLink accounts. |

The `vault` field on BuyParams is the vault creator's public key (used to derive the vault PDA). The buyer's VaultWalletLink is derived from the buyer's key. If `vault` is omitted, the buy works as before (backward compatible).

## New Query Functions

| Function | Returns |
|---|---|
| `getVault(connection, creatorPubkey)` | Vault state (balance, authority, linked wallets count, etc.) |
| `getVaultForWallet(connection, walletPubkey)` | Vault state by looking up the wallet's VaultWalletLink |
| `getVaultWalletLink(connection, walletPubkey)` | Link state (which vault, when linked) or null |

## PDA Derivation

```
TorchVault:      [b"torch_vault", creator.key()]
VaultWalletLink: [b"vault_wallet", wallet.key()]
```

## Files Modified

| File | Change |
|---|---|
| `torch_market.json` | Replace with v3.0.0 IDL |
| `constants.ts` | Add TORCH_VAULT_SEED, VAULT_WALLET_LINK_SEED |
| `types.ts` | Add vault params/result types |
| `program.ts` | Add vault PDA helpers, TorchVault/VaultWalletLink interfaces |
| `transactions.ts` | Add 6 vault builders, modify buildBuyTransaction |
| `index.ts` | Export new builders and types |
| `tokens.ts` | Add vault query functions |
| `tests/test_e2e.ts` | Add vault lifecycle + vault buy test flow |
| `package.json` | Bump to 2.0.0 |

## E2E Test Flow

```
1. Create vault (creator = wallet)
2. Deposit 5 SOL into vault
3. Query vault (verify balance)
4. Create token
5. Buy with vault (verify vault balance decreases, buyer gets tokens)
6. Sell (no vault — direct)
7. Link second wallet
8. Buy with linked wallet via vault
9. Withdraw remaining vault SOL
10. Existing lifecycle tests (bond → migrate → borrow → repay)
```
