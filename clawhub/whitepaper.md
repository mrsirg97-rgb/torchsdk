# torch.market

**a programmable economic substrate**

Brightside Solutions, 2026

[torch.market](https://torch.market) | [developer docs](https://torch-market-docs.vercel.app/) | [audit](https://torch.market/audit.md) | [@torch_market](https://x.com/torch_market/)

---

`torch.market` is a programmable economic substrate built on Solana. Every token launched on the protocol is its own self-sustaining economy — complete with a pricing engine, a central bank, a lending market, community governance, and optional privacy — all enclosed within a single non-extractive system where every action feeds a positive-sum feedback loop.

The protocol treats Solana not as a blockchain, but as a distributed computing substrate coupled with storage. On-chain accounts form a directed graph of economic relationships. PDA seeds define the edges. Handlers define the legal traversals. The result is a composable economic graph where anyone can launch a token and receive a complete, self-reinforcing financial ecosystem out of the box.

Unlike traditional launchpads that extract value from participants, `torch.market` is non-extractive by topology — there is no edge in the graph that removes value from the system. Fees become buybacks. Buybacks become deflation. Failed tokens become protocol rewards. Every outflow is an inflow somewhere else. This is not a zero-sum game by design.

The architecture works as follows:

---

## The Economic Graph

Every token on `torch.market` instantiates a complete economic ecosystem. The on-chain accounts form a directed acyclic graph where each node is an autonomous economic actor:

```
Per-Token Economy:

  Mint ──── Bonding Curve ──── Treasury
  │              │                 │
  │         Token Vault       Buybacks ──── Burn / Hold
  │              │                 │
  │         User Positions    Lending ──── Collateral Vault
  │              │                 │
  │            Votes          Stars ──── Creator Payout
  │                                │
  │                            Migration ──── Raydium DEX Pool
  │
  └── Token-2022 Extensions
       ├── Transfer Fee (0.1%)
       └── Confidential Transfer (optional)

Protocol Layer:

  Protocol Treasury ◄── Fees + Reclaims
       │
       └── Epoch Rewards ──── Active Traders

Vault Layer (optional resolver):

  TorchVault ◄── VaultWalletLink (identity)
       │
       └── Routes to: buy, sell, star, borrow, repay, swap
```

Each node maintains its own invariants. Each edge is structurally enforced by PDA derivation — the relationships between accounts are guaranteed by the runtime, not by application logic. A treasury can only exist for a bonding curve, which can only exist for a mint. The topology is the security model.

The **Torch Vault** acts as a protocol-native graph resolver — a middleware layer that sits between any caller and any action, resolving identity, SOL source, and token destination without knowing or caring what action is being performed. Two PDAs turn every economic flow in the protocol into a custody-aware operation.

Because the graph is complete — every meaningful economic flow is already a valid traversal — new capabilities emerge from the existing structure. Optional privacy is a single extension on the mint node. Vault custody is an optional dimension on every traversal. No refactoring needed. The graph just gets deeper.

---

## 1. Token Treasury: The Core Mechanic

Every token is launched with a **token treasury**, which is a wallet that acts as an automatic market maker and depreciates token supply.

The token treasury is the core mechanic of `torch.market`. Everyone talks supply control, but in `torch.market`, the protocol *is* the supply control. During bonding, the fee structure is as follows:

```
User spends 1 SOL
        │
        ├── 1% → Protocol Fee (pre-bonding only)
        │         ├── 75% → Protocol Treasury
        │         └── 25% → Dev Wallet
        │
        ├── 1% → Token Treasury Fee (lifetime)
        │
        └── 98% → Remainder
                  ├── V2.3 Dynamic → Token Treasury (SOL)
                  │   └── 20% at start → 5% at completion
                  └── V2.3 Dynamic → Bonding Curve
                      └── 80% at start → 95% at completion
                                ├── 90% → User (tokens)
                                └── 10% → Community Treasury (vote vault)
```

> **Dynamic Treasury Rate**: The treasury SOL split uses inverse decay based on bonding progress. Early buyers contribute more to treasury (stronger early funding), late buyers get more tokens per SOL. The rate is flat across all tiers (Spark 50, Flame 100, Torch 200 SOL).
>
> | 0 SOL | 50% of target | 100% of target |
> |-------|---------------|----------------|
> | 20%   | 12.5%         | 5%             |

This creates a different mindset to how newly minted tokens are created. Users are not just paying into themselves, but paying into the long term growth of their communities.

### How the Token Treasury Benefits Users

The token treasury creates a positive-sum dynamic where every participant's actions strengthen the entire ecosystem:

1. **Automatic Price Support**: The treasury accumulates SOL with every buy. This SOL is used to execute buybacks when the token is on DEX, creating constant buy pressure that supports the price floor.
2. **Supply Reduction**: Tokens acquired through buybacks are burned (until a 500M floor is reached), permanently reducing circulating supply. This deflationary pressure benefits all holders proportionally.
3. **No Insider Advantage**: Unlike traditional launches where team allocations can dump on retail, the treasury mechanism ensures that value flows back to all participants. There is no creator allocation, only a 100% fair launch.
4. **Community-Funded Migration**: The treasury pays the 0.15 SOL Raydium pool creation fee automatically. Early supporters collectively fund the DEX migration without any single party bearing the cost.
5. **Long-term Alignment**: Because the treasury continuously performs buybacks, early sellers forfeit future buyback benefits. This incentivizes holding and community building over quick flips.

---

## 2. Community Vote: Token Holders Decide

Each user casts a vote prelaunch to determine what happens to 10% of their tokens.

Once a token reaches its bonding target (50, 100, or 200 SOL depending on tier), the community votes to decide what happens to the tokens held in the community treasury (vote vault). The voters can decide to:

- **Burn**: Destroy the tokens forever, reducing total supply from 1B to 900M
- **Return to LP**: Add the tokens back to the migrated DEX pool for deeper liquidity

Providing a group proposal solidifies project community before the DEX launch and gives all wallets a say:

```
1 wallet = 1 vote
```

The vote outcome is binding and executed automatically during migration.

---

## 3. Wallet Limits: Anti-Whale Protection

Any given wallet is restricted to at most *2% of the entire supply* of the token.

By restricting wallets to a hard limit on the total amount of tokens that they own before launch, this ensures better fairness for all wallets purchasing on the bond. Individual wallets can no longer control the entire supply of a given token at once, limiting the chance of price manipulation and dumping on incoming buyers.

New buyers may also be more likely to purchase a token seeing that it is "safer" from whale manipulation. A downside to this is that a single user may control more than 1 wallet, which could be considered a sybil attack against the protocol. However, this is partially mitigated by:

- The fee structure itself (sybiling costs more in fees)
- The community treasury (even sybil buyers fund the collective)
- Post-migration transfer fees (every transfer costs 0.1%)

---

## 4. Permissionless Migration

The token treasury pays the migration fee to DEX. Anyone can trigger it.

One of the main issues with current launchpads is that somebody has to pay the migration fee for the token to be migrated to a decentralized exchange. Because the treasury wallet is fully funded by the time the token bonds at its target (50/100/200 SOL), it is given the authority to pay the Raydium pool creation fee (0.15 SOL).

Migration is **permissionless** — any wallet can trigger the migration for any bonding-complete token. The triggering wallet pays a small rent fee (~0.02 SOL) for the WSOL account, while the treasury covers the 0.15 SOL Raydium pool creation fee. This means no single party can block a token from graduating to DEX.

The migration is executed as a two-step atomic process within a single transaction:

1. **Fund WSOL**: Wrap the bonding curve's SOL reserves into a WSOL token account
2. **Migrate to DEX**: Vote finalization, pool creation on Raydium CPMM, liquidity provision (SOL + tokens), LP token burn (liquidity locked forever), transfer fee activation (0.1% on all future transfers)

When your token bonds, anyone can complete the migration. The community is not dependent on the creator or any centralized operator.

---

## 5. Post-Migration: Automatic Buybacks and Burns

Once a token migrates to Raydium, the treasury mechanics continue working for holders through the **0.1% transfer fee**.

### The 0.1% Transfer Fee (Token-2022)

All `torch.market` tokens use Solana's Token-2022 standard with a built-in **0.1% transfer fee**. This fee is collected on every transfer — wallet to wallet, DEX trades, everything.

```
User transfers 100 tokens
        │
        └── 0.1% (0.1 token) → Withheld in mint
                            │
                            └── Harvested → Token Treasury
```

The transfer fee is not extracted from the sender or receiver as a separate charge — it's automatically withheld from the transferred amount. If you send 1000 tokens, the recipient receives 999 and 1 is held for the treasury.

### Harvest and Buyback Cycle

The accumulated transfer fees create a perpetual buyback engine:

1. **Harvest** (permissionless): Anyone can call `harvest_fees` to collect withheld tokens from transfers into the token treasury's token account.
2. **Swap to SOL** (permissionless): Anyone can call `swap_fees_to_sol` to sell the harvested tokens back to SOL via Raydium, adding the proceeds to the treasury's SOL balance. The SDK bundles harvest + swap in one atomic transaction via `buildSwapFeesToSolTransaction`.
3. **Buyback** (permissionless): Anyone can call `execute_auto_buyback` to execute a market buy using treasury SOL when price dips. The bought tokens are burned.
4. **Burn**: Acquired tokens are permanently burned, reducing supply. When supply reaches the 500M floor, tokens are held in treasury instead (preventing hyper-deflation).

### Buyback Parameters

- **Interval**: Minimum ~18 minutes between buybacks
- **Amount**: 15% of available treasury SOL per buyback
- **Reserve**: 30% of treasury SOL is held in reserve
- **Supply Floor**: Burning stops at 500M tokens (50% of initial supply)

This creates a continuous deflationary pressure. Every time someone trades the token on any DEX or transfers between wallets, the treasury grows stronger and future buybacks become larger.

### Treasury Behavior Summary

| Phase | SOL Source | Token Destination |
|-------|-----------|-------------------|
| Bonding | 1% fee + 20%→5% of buys (dynamic) | Community treasury (vote vault) |
| DEX | 0.1% transfer fee (harvested) | Burned (or held at floor) |

---

## 6. Treasury Lending

After migration, the token treasury holds SOL that fuels buybacks. Holders can also **borrow SOL against their tokens**, turning idle treasury capital into productive liquidity while maintaining the buyback flywheel.

### How It Works

1. **Deposit Collateral**: A holder deposits tokens into the lending vault. The tokens are locked but remain the borrower's property.
2. **Borrow SOL**: The borrower receives SOL from the token treasury up to the maximum loan-to-value ratio. The borrowed amount is capped by both the LTV and the treasury's utilization cap.
3. **Repay**: The borrower returns the SOL plus accrued interest. Interest is calculated per-epoch (approximately 7 days). Upon repayment, collateral tokens are unlocked.
4. **Liquidation**: If the collateral value falls below the liquidation threshold, anyone can liquidate the position. The liquidator repays the debt and receives the collateral plus a bonus.

### Lending Parameters

- **Max LTV**: 50% — borrow up to half the value of deposited collateral
- **Liquidation Threshold**: 65% — position is liquidatable when debt exceeds 65% of collateral value
- **Interest Rate**: 2% per epoch (~7 days)
- **Liquidation Bonus**: 10% — liquidators receive collateral at a 10% discount
- **Utilization Cap**: 50% — at most half of treasury SOL can be lent out at any time

### Collateral Pricing

Token prices are derived from the Raydium pool reserves. The protocol reads the pool's SOL and token balances on-chain and computes the spot price. No external oracles are required — pricing is fully on-chain and permissionless.

### Synergy with Buybacks

Interest paid by borrowers flows back into the token treasury. This additional SOL fuels larger buybacks, creating a positive feedback loop: more lending → more interest → more buybacks → higher token price → more borrowing capacity.

> **Immutable Parameters**: All lending parameters (LTV, liquidation threshold, interest rate, bonus, utilization cap) are set at pool creation and are immutable on-chain. No admin key can change them after deployment.

---

## 7. Protocol Treasury: Rewarding Active Traders

The protocol level fees don't just go to the development team, they're redistributed to active platform users.

### How It Works

During the bonding phase, 1% of every buy goes to the protocol. This is split:

- 75% → Protocol Treasury (for user rewards)
- 25% → Dev Wallet (for development)

The Protocol Treasury accumulates SOL and distributes it to active traders every *7 days (1 epoch)*.

### Epoch Reward Distribution

1. **Reserve Floor**: The protocol treasury maintains a 1,500 SOL reserve floor. Only SOL above this threshold is distributed.
2. **Volume Eligibility**: To claim rewards, a user must have traded at least *10 SOL in volume* during the previous epoch.
3. **Pro-Rata Share**: Eligible users receive rewards proportional to their trading volume:
   ```
   user_reward = (user_volume / total_volume) × distributable_amount
   ```
4. **Claim**: Users must actively claim their rewards. Unclaimed rewards roll into the next epoch.

### Example

If the protocol treasury has 2,000 SOL:
- Reserve floor: 1,500 SOL (untouchable)
- Distributable: 500 SOL

If total eligible volume was 50,000 SOL and you traded 5,000 SOL:
- Your share: 5,000 / 50,000 = 10%
- Your reward: **50 SOL**

This mechanism rewards the most active participants on the platform and creates an incentive loop: more trading → more fees → more rewards → more trading.

---

## 8. Token Reclaim and Revival

Not every token succeeds. `torch.market` has mechanisms to handle failed tokens and even give them a second chance.

### Reclaim: Cleaning Up Failed Tokens

If a token fails to reach its bonding target (50/100/200 SOL depending on tier) and becomes inactive for *7 days*, anyone can trigger a reclaim:

```
Conditions for reclaim:
  ✓ Bonding not complete (target not reached)
  ✓ No trading activity for 7+ days
  ✓ At least 0.01 SOL in reserves (not dust)
```

When reclaimed:

1. All SOL from the bonding curve is transferred to the protocol treasury
2. All SOL from the token treasury is transferred to the protocol treasury
3. The token is marked as "reclaimed" and trading is disabled

The reclaimed SOL joins the protocol treasury and is distributed to active traders in the next epoch. Failed tokens become rewards for successful traders.

### Revival: Second Chances

A reclaimed token can be **revived** if the community believes in it. Anyone can contribute SOL to a reclaimed token:

```
Revival threshold (V27): 3BT/8 (18.75 SOL Spark, 37.5 SOL Flame, 75 SOL Torch)
Legacy tokens: BT/8 (6.25 SOL Spark, 12.5 SOL Flame, 25 SOL Torch)
```

Contributors are patrons — they do NOT receive tokens for their contribution. They're simply signaling belief that the token deserves another chance. Once the revival threshold is reached:

1. The `reclaimed` flag is removed
2. Trading is re-enabled
3. The token continues from where it left off

This creates a natural market for "distressed" tokens. If a token had real community support but just needed more time, revival gives it that chance.

---

## 9. On-Chain Messages

Every token on `torch.market` has a **message board**. Messages are stored on-chain using the SPL Memo program, making them permanent and censorship-resistant.

### Skin in the Game

Messages can be bundled with trades. When a user buys or sells a token, they can attach a message to the transaction. This ties commentary directly to economic action — every message comes from someone with skin in the game.

### Standalone Messages

Users can also post standalone messages without trading. These are recorded via the SPL Memo program and associated with the token's message board. Standalone messages still require a wallet signature, ensuring accountability.

### Why On-Chain?

- **Permanence**: Messages cannot be deleted or altered after posting
- **Attribution**: Every message is signed by the sender's wallet
- **Context**: Trade-attached messages show what the sender did, not just what they said
- **Composability**: Any client, bot, or agent can read and post messages using the same on-chain interface

---

## 10. Verification & Trust (SAID Protocol)

`torch.market` integrates the **SAID protocol** — an on-chain identity layer for agents and humans. SAID provides verifiable trust without requiring personal information.

### Trust Tiers

Each verified wallet receives a trust tier based on on-chain activity and verification depth:

| Tier | Color |
|------|-------|
| High | Emerald / Green |
| Medium | Blue |
| Low | Yellow |

### Where Badges Appear

- Token cards on the explore page
- Token detail pages (next to the creator wallet)
- Message boards (next to each message author)

### Reputation Scoring

Reputation is earned through on-chain activity on the platform:

- **+15 points**: Launch a token
- **+5 points**: Execute a trade
- **+10 points**: Cast a community vote

---

## 11. Built for Agents

`torch.market` is designed for both humans and AI agents. There is no API server between the agent and the protocol. Solana is the compute layer. The Torch SDK builds transactions locally from the on-chain program's Anchor IDL and reads all state directly from Solana RPC. No middleman, no API keys, no trust assumptions beyond the on-chain program itself.

### Direct On-Chain Access

Every protocol action — buy, sell, lend, govern, message — is an instruction on the Solana program. The SDK constructs these instructions locally using the Anchor IDL, serializes them into unsigned transactions, and submits them to any Solana RPC endpoint. The agent signs with its own keypair. No server processes the request. No intermediary touches the transaction. The path is:

```
Agent → SDK (local, Anchor IDL) → Solana RPC → On-chain program
```

This is a direct consequence of treating Solana as a computing substrate. The program is the API. The accounts are the database. The RPC is the network layer. There is nothing else to trust, nothing else to go down, nothing else to rate-limit.

### Discovery Chain

Agents discover `torch.market` through a standard discovery chain:

```
llms.txt          → Human/AI-readable overview
  └── agent.json  → Structured metadata, capabilities, actions
  └── skill.md    → Machine-readable SDK reference
  └── openapi.json → Full OpenAPI specification
```

### Agent Kit Plugin

For agents built on the Solana Agent Kit, a dedicated plugin is available:

```
npm install solana-agent-kit-torch-market
```

The plugin wraps the SDK with typed actions (buy, sell, create, vote, lend, message) and handles transaction signing automatically. Humans and agents use the same on-chain program — there is no separate "bot mode."

---

## 12. Protocol Architecture

The on-chain program is a directed graph of economic relationships. PDA seeds define the edges, handlers define the legal traversals. The topology enforces correctness — relationships between accounts are guaranteed by the Solana runtime, not by application logic.

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                          TORCH MARKET PROTOCOL v3.7.17                                │
├─────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                           PROTOCOL LAYER                                     │    │
│  │  ┌─────────────────┐  ┌──────────────────────────────────────┐              │    │
│  │  │  GlobalConfig   │  │        ProtocolTreasury               │              │    │
│  │  │  (authority,    │  │  (1% fees + reclaimed SOL,            │              │    │
│  │  │   settings)     │  │   1500 SOL floor, epoch rewards)      │              │    │
│  │  └─────────────────┘  └──────────────────────────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                       │                                              │
│                                       ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                           PER-TOKEN LAYER                                    │    │
│  │                                                                              │    │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │    │
│  │  │    Token     │    │   Bonding    │    │   Treasury   │                   │    │
│  │  │   (Mint)     │───▶│    Curve     │───▶│  (buybacks,  │                   │    │
│  │  │  Token-2022  │    │  (pricing,   │    │   stars,     │                   │    │
│  │  │ 0.1% xfer fee│    │   voting)    │    │   lending)   │                   │    │
│  │  └──────────────┘    └──────┬───────┘    └──────────────┘                   │    │
│  │                             │                                                │    │
│  │         ┌───────────────────┼───────────────────┐                           │    │
│  │         ▼                   ▼                   ▼                           │    │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │    │
│  │  │  Token Vault │    │  Treasury's  │    │  Raydium     │                   │    │
│  │  │  (tradeable  │    │  Token Acct  │    │  CPMM Pool   │                   │    │
│  │  │   supply)    │    │  (vote vault)│    │  (post-grad) │                   │    │
│  │  └──────────────┘    └──────────────┘    └──────────────┘                   │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                       │                                              │
│                                       ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                            USER LAYER                                        │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │    │
│  │  │  UserPosition   │  │   UserStats     │  │   StarRecord    │              │    │
│  │  │  (per-token     │  │  (platform-wide │  │  (per-token     │              │    │
│  │  │   holdings,     │  │   volume,       │  │   appreciation) │              │    │
│  │  │   vote)         │  │   rewards)      │  │                 │              │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                       │                                              │
│                                       ▼                                              │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │                    VAULT LAYER (V3.1.0 — Full Custody)                       │    │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐              │    │
│  │  │   TorchVault    │  │VaultWalletLink  │  │  Vault ATAs     │              │    │
│  │  │  (per-creator   │◀─│  (per-wallet    │  │  (per-mint      │              │    │
│  │  │   SOL + token   │  │   reverse       │  │   token accts   │              │    │
│  │  │   full custody) │  │   pointer)      │  │   owned by PDA) │              │    │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘              │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
│                                                                                      │
├─────────────────────────────────────────────────────────────────────────────────────┤
│  INSTRUCTION HANDLERS (28 total)                                                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐      │
│  │ admin  │ │ token  │ │ market │ │treasury│ │ dex    │ │rewards │ │reclaim │      │
│  │        │ │        │ │        │ │/lending│ │migrate │ │        │ │/revival│      │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘ └────────┘      │
│  ┌────────┐ ┌────────┐                                                               │
│  │ vault  │ │  swap  │                                                               │
│  │        │ │(V3.1.1)│                                                               │
│  └────────┘ └────────┘                                                               │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### On-Chain Account Types

The protocol uses 12 on-chain account types, all deterministic PDAs:

| Account | PDA Seeds | Purpose |
|---------|-----------|---------|
| **GlobalConfig** | `["global_config"]` | Protocol-wide settings (authority, fees, pause flag) |
| **BondingCurve** | `["bonding_curve", mint]` | Per-token pricing state, reserves, votes, bonding target |
| **Treasury** | `["treasury", mint]` | Per-token treasury (SOL for buybacks, star balance, lending pool) |
| **TreasuryLock** | `["treasury_lock", mint]` | [V27] Holds 250M locked tokens (25% of supply) |
| **UserPosition** | `["user_position", bc, user]` | Per-user per-token holdings and vote |
| **UserStats** | `["user_stats", user]` | Platform-wide volume and reward tracking |
| **ProtocolTreasury** | `["protocol_treasury_v11"]` | Single treasury: fees + reclaims, 1500 SOL floor, epoch rewards |
| **StarRecord** | `["star_record", user, mint]` | Prevents double-starring |
| **LoanPosition** | `["loan", mint, user]` | Per-user per-token lending position |
| **TorchVault** | `["torch_vault", creator]` | Per-creator full-custody SOL + token escrow |
| **VaultWalletLink** | `["vault_wallet", wallet]` | Reverse pointer: wallet → vault (one link per wallet) |

### Instruction Set

The V3.7.17 program exposes 28 instructions across 9 handler domains:

| Domain | Instructions |
|--------|-------------|
| **Admin** | `initialize`, `initialize_protocol_treasury`, `update_dev_wallet` |
| **Token** | `create_token` |
| **Market** | `buy`, `sell` |
| **Treasury** | `harvest_fees`, `swap_fees_to_sol` |
| **Migration** | `fund_migration_wsol`, `migrate_to_dex`, `execute_auto_buyback` |
| **Rewards** | `advance_protocol_epoch`, `claim_protocol_rewards`, `star_token` |
| **Reclaim/Revival** | `reclaim_failed_token`, `contribute_revival` |
| **Vault** | `create_vault`, `deposit_vault`, `withdraw_vault`, `link_wallet`, `unlink_wallet`, `transfer_authority`, `withdraw_tokens` |
| **Swap** | `fund_vault_wsol`, `vault_swap` |
| **Lending** | `borrow`, `repay`, `liquidate` |

> **Note (V3.7.0):** `update_authority` was removed. Authority transfer is now done at deployment time via multisig tooling rather than an on-chain instruction, reducing the protocol's admin attack surface. Minimal admin surface: only `initialize` and `update_dev_wallet` require authority.
>
> **Note (V3.7.10):** `swap_fees_to_sol` added. Sells harvested Token-2022 transfer fee tokens back to SOL via Raydium CPMM. Permissionless — anyone can call after migration. 28 instructions total.
>
> **Note (V3.7.17):** Metaplex `add_metadata` removed (temporary backfill complete). Transfer fee reduced from 1% to 0.1% (`TRANSFER_FEE_BPS` 100→10). All tokens now use Token-2022 metadata extensions exclusively. 28 instructions total.

### Bonding Curve Formula

The protocol uses a constant product bonding curve:

```
Buy:   tokens_out = (virtual_token_reserves × sol_in) / (virtual_sol_reserves + sol_in)
Sell:  sol_out    = (virtual_sol_reserves × token_in) / (virtual_token_reserves + token_in)
Price: price      = virtual_sol_reserves / virtual_token_reserves
```

**Tiered Virtual Reserves (V27):** Each tier has per-tier initial virtual reserves tuned for a consistent ~13.44x multiplier:

| Tier | Target | IVS (3BT/8) | IVT | Curve Supply | Treasury Lock |
|------|--------|-------------|-----|-------------|---------------|
| **Spark** | 50 SOL | 18.75 SOL | 756.25M | 750M (75%) | 250M (25%) |
| **Flame** | 100 SOL | 37.5 SOL | 756.25M | 750M (75%) | 250M (25%) |
| **Torch** | 200 SOL | 75 SOL | 756.25M | 750M (75%) | 250M (25%) |

### Fee Flow

```
                              BUYER'S SOL
                                  │
                                  ▼
               ┌──────────────────────────────────────┐
               │           TOTAL SOL INPUT            │
               └──────────────────────────────────────┘
                                  │
           ┌──────────────────────┼──────────────────────┐
           │                      │                      │
           ▼                      ▼                      ▼
    ┌─────────────┐       ┌─────────────┐       ┌─────────────┐
    │  1% Protocol│       │ 1% Treasury │       │    98%      │
    │    Fee      │       │    Fee      │       │  Remaining  │
    └──────┬──────┘       └──────┬──────┘       └──────┬──────┘
           │                     │                     │
      ┌────┴────┐                │              ┌──────┴──────┐
      │         │                │              │             │
      ▼         ▼                ▼              ▼             ▼
┌─────────┐ ┌─────────┐   ┌──────────┐   ┌───────────┐ ┌───────────┐
│Protocol │ │  Dev    │   │  Token   │   │  Token   │ │  Bonding  │
│Treasury │ │ Wallet  │   │ Treasury │   │ Treasury │ │   Curve   │
│  (75%)  │ │  (25%)  │   │  (100%)  │   │(20%→5%)  │ │(80%→95%)  │
└─────────┘ └─────────┘   └────┬─────┘   └───────────┘ └─────┬─────┘
                               │                             │
                               │                              ▼
                               │                        ┌─────────────┐
                               │                        │   TOKENS    │
                               │                        │    OUT      │
                               │                        └──────┬──────┘
                               │                               │
                               │                      ┌────────┴────────┐
                               │                      │                 │
                               ▼                      ▼                 ▼
                        ┌─────────────┐        ┌─────────────┐   ┌───────────┐
                        │  BUYBACKS   │        │   BUYER     │   │ COMMUNITY │
                        │  (on dips)  │        │   (90%)     │   │ TREASURY  │
                        └─────────────┘        └─────────────┘   │   (10%)   │
                                                                 └─────┬─────┘
                                                                       │
                                                           ┌───────────┴───────────┐
                                                           │      AT MIGRATION     │
                                                           │    (based on vote)    │
                                                           ├───────────────────────┤
                                                           │ BURN → destroy tokens │
                                                           │ RETURN → add to LP    │
                                                           └───────────────────────┘
```

### Security Model

**Access Control:**
- **Authority-only:** `initialize`, `update_dev_wallet`
- **Vault authority-only:** `withdraw_vault`, `link_wallet`, `unlink_wallet`, `transfer_authority`, `withdraw_tokens`
- **Permissionless cranks:** `advance_protocol_epoch`, `harvest_fees`, `swap_fees_to_sol`, `fund_migration_wsol`, `migrate_to_dex`, `execute_auto_buyback`, `reclaim_failed_token`, `liquidate`
- **Permissionless deposits:** Anyone can deposit into any vault

**Vault Security (V3.1.0 — Full Custody):**
- One vault per creator (PDA uniqueness)
- One link per wallet (PDA uniqueness)
- Authority separation: `creator` (immutable seed) vs `authority` (transferable admin)
- All value stays in vault — agent wallet never holds tokens or significant SOL
- CPI ordering enforced: token CPIs before lamport manipulation in all vault paths
- Compromised key safety: attacker gets dust, authority unlinks and re-links

**Raydium Pool Validation (V27 — PDA-Based):**
Pool accounts validated via PDA derivation constraints in Anchor contexts (`derive_pool_state`, `derive_pool_vault`, `derive_observation_state`). AMM config hardcoded to prevent fee-tier substitution. Oracle manipulation impossible — an attacker cannot derive a valid PDA pointing to a fake pool.

### Formal Verification

Core arithmetic is formally verified with [Kani](https://model-checking.github.io/kani/) — 36 proof harnesses, all passing, covering every possible input in constrained ranges. Proofs cover: fee calculations, bonding curve pricing, lending formulas (borrow/repay/liquidate lifecycle), reward distribution, auto-buyback, migration conservation, and V25/V27 token distribution. No SOL can be created from nothing, no tokens can be minted from thin air, and no fees can exceed their stated rates. See [VERIFICATION.md](https://torch.market/verification.md).

### Security Audit History

**V3.2.1 — `harvest_fees` Unconstrained Destination (CRITICAL, Fixed)**
The `harvest_fees` instruction did not validate that `treasury_token_account` matched the treasury PDA's ATA. An attacker could substitute their own Token-2022 ATA and steal all accumulated transfer fees. Fixed with Anchor `associated_token` constraints. Independent auditor verified.

**V3.2.1 — Oracle Manipulation via Unconstrained Raydium Pool (Non-Issue)**
Pool accounts were reported as unconstrained. Assessment: `validate_pool_accounts()` already validates pool ownership, vault addresses, and mint composition. V27 further hardens this with PDA-based derivation constraints.

---

## Token Lifecycle

```
CREATE → BONDING → COMPLETE → VOTE → MIGRATE → DEX
   │                                              │
   │                                              ▼
   │                                    [0.1% Transfer Fee]
   │                                              │
   │                                              ▼
   │                                    HARVEST → SWAP TO SOL → BUYBACK → BURN
   │                                              │
   │                                     ┌────────┴────────┐
   │                                     │                  │
   │                              [TREASURY LENDING]  [MESSAGE BOARD]
   │                                     │
   │                              BORROW ↔ REPAY
   │                                     │
   │                                LIQUIDATION
   │
   ▼ (if 7 days inactive)
RECLAIM ──────────────────────────────────────────────────────┐
   │                                                           │
   ▼                                                           ▼
REVIVAL (IVS per tier) ──→ TRADING RESUMES          PROTOCOL TREASURY
                                                              │
                                                              ▼
                                                    EPOCH REWARDS TO TRADERS
```

Every path in this graph feeds value back into the system. There is no terminal node that extracts value — only cycles that compound it.

---

## Constants Reference

| Parameter | Value | Description |
|-----------|-------|-------------|
| Total Supply | 1,000,000,000 | Initial token supply (6 decimals) |
| Max Wallet | 2% (20,000,000) | Maximum tokens per wallet during bonding |
| Bonding Target | 50 / 100 / 200 SOL | Spark / Flame / Torch tier (creator chooses at launch) |
| Community Treasury | 10% | Portion of bought tokens to vote vault |
| Treasury SOL Share | 20%→5% | Dynamic: decays as bonding progresses |
| Token Treasury Fee | 1% | Fee on all buys (lifetime) |
| Protocol Fee | 1% | Fee during bonding (75% treasury, 25% dev) |
| Transfer Fee | 0.1% | Post-migration fee on all transfers |
| Supply Floor | 500,000,000 | Minimum supply (buyback burns stop here) |
| Inactivity Period | 7 days | Time before failed token can be reclaimed |
| Revival Threshold (V27) | 3BT/8 per tier (18.75 / 37.5 / 75 SOL) | SOL needed to revive a reclaimed token |
| Voting Duration | ~24 hours | Time for community to vote on burn/return |
| Epoch Duration | 7 days | Protocol reward distribution cycle |
| Reward Eligibility | 10 SOL | Minimum epoch volume for protocol rewards |
| Protocol Reserve | 1,500 SOL | Minimum protocol treasury balance |
| Max LTV | 50% | Maximum loan-to-value for treasury lending |
| Liquidation Threshold | 65% | Debt-to-collateral ratio triggering liquidation |
| Interest Rate | 2% / epoch | Lending interest per ~7-day epoch |
| Liquidation Bonus | 10% | Discount for liquidators on seized collateral |
| Utilization Cap | 50% | Max fraction of treasury SOL available for loans |
| Min Borrow | 0.1 SOL | Minimum borrow amount per loan |

---

## Version History

| Version | Features |
|---------|----------|
| V1 | Basic bonding curve, buy/sell |
| V2 | Treasury, buybacks, permanent burn split |
| V3 | Token-2022 with transfer fees |
| V4 | Failed token reclaim, platform rewards |
| V5 | Raydium DEX migration |
| V8 | Dev wallet split (25% of treasury fee) |
| V9 | Auto-buyback on DEX price dips |
| V10 | Simplified star system with auto-payout |
| V11 | Protocol treasury with 1500 SOL reserve floor |
| V12 | Token revival |
| V2.2 | 10% tokens to community treasury, 90% to buyer |
| V2.3 | Dynamic treasury SOL rate: 20%→5% decay |
| V2.4 | Treasury lending: borrow SOL against token collateral |
| V3.0.0 | **Torch Vault — Multi-Wallet Identity.** Per-creator SOL escrow with multi-wallet support. 6 new vault instructions. |
| V3.1.0 | **Vault Full Custody.** Buy, sell, star, borrow, repay all vault-routed. New `withdraw_tokens` (authority-only). |
| V3.1.1 | **Vault DEX Swap.** `fund_vault_wsol` + `vault_swap` for Raydium trading via vault. |
| V3.2.0 | **Platform treasury merged into protocol treasury.** Single reward system. |
| V3.2.1 | **Security: `harvest_fees` hardened.** Critical vulnerability fixed, auditor verified. |
| V3.3.0 | **Tiered Bonding Curves.** Spark (50 SOL), Flame (100 SOL), Torch (200 SOL). |
| V3.5.0 | **V25 Pump-Style Token Distribution.** IVS = BT/8, IVT = 900M tokens, ~81x multiplier. 35 Kani proofs. |
| V3.6.0 | **V26 Permissionless Migration + Authority Revocation.** Mint and freeze authority revoked permanently at migration. |
| V3.6.x | **V27 Treasury Lock + PDA Pool Validation.** 250M tokens locked at creation. IVS = 3BT/8, 13.44x multiplier. |
| V3.7.0 | **V28 `update_authority` Removed.** Authority transfer via multisig tooling. 27 instructions. Minimal admin surface. |
| V3.7.17 | **V29 On-Chain Metadata.** Metaplex `add_metadata` removed (temporary backfill complete). Transfer fee reduced from 1% to 0.1%. All tokens use Token-2022 metadata extensions exclusively. 28 instructions. |
| V3.7.10 | **V20 Swap Fees to SOL.** New `swap_fees_to_sol` instruction sells harvested Token-2022 fees to SOL via Raydium. 28 instructions. Vault ordering bug fix in pool validation. |

---

## Conclusion

`torch.market` is a programmable economic substrate. Every token launched on the protocol receives a complete, self-sustaining economy: a pricing engine, a central bank with automatic buybacks, a lending market, community governance, creator rewards, a failure-recovery system, and optional privacy — all composed from a small set of on-chain primitives that enforce correctness by topology.

The protocol is non-extractive by design. There is no configuration that makes it extractive because the graph doesn't have that edge. Fees become buybacks. Buybacks become deflation. Failed tokens become protocol rewards. Interest from lending fuels larger buybacks. Every outflow is an inflow somewhere else in the system.

The Torch Vault adds a custody-aware resolution layer that makes every economic flow in the protocol accessible through a single identity — without adding economic complexity. Agents and humans use the same on-chain program, the same API, the same graph.

The individual pieces — bonding curves, treasuries, lending, governance — are not new. The arrangement is. A closed, positive-sum economic graph where anyone can launch a token and receive a complete financial ecosystem, running on Solana as a distributed computing substrate.

**This is not a zero-sum game. This is not a launchpad. This is a substrate for programmable economies.**

---

*© 2026 Brightside Solutions. All rights reserved.*

[Terms](https://torch.market/terms) | [Privacy](https://torch.market/privacy) | [torch.market](https://torch.market)
