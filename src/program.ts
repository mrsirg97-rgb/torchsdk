import { Program, AnchorProvider, BN } from '@coral-xyz/anchor'
import { PublicKey } from '@solana/web3.js'
import {
  PROGRAM_ID,
  GLOBAL_CONFIG_SEED,
  BONDING_CURVE_SEED,
  TREASURY_SEED,
  USER_POSITION_SEED,
  VOTE_SEED,
  PROTOCOL_TREASURY_SEED,
  USER_STATS_SEED,
  STAR_RECORD_SEED,
  LOAN_SEED,
  COLLATERAL_VAULT_SEED,
  TORCH_VAULT_SEED,
  VAULT_WALLET_LINK_SEED,
  RAYDIUM_CPMM_PROGRAM,
  WSOL_MINT,
  RAYDIUM_AMM_CONFIG,
  TOKEN_2022_PROGRAM_ID,
} from './constants'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'

// Re-export program ID for convenience
export { PROGRAM_ID }
import idl from './torch_market.json'

// Types from IDL (snake_case to match Anchor decoding)
export interface BondingCurve {
  mint: PublicKey
  creator: PublicKey
  virtual_sol_reserves: BN
  virtual_token_reserves: BN
  real_sol_reserves: BN
  real_token_reserves: BN
  vote_vault_balance: BN // [V13] Renamed from burned_token_reserves
  permanently_burned_tokens: BN
  bonding_complete: boolean
  bonding_complete_slot: BN
  votes_return: BN
  votes_burn: BN
  total_voters: BN
  vote_finalized: boolean
  vote_result_return: boolean
  migrated: boolean
  is_token_2022: boolean
  last_activity_slot: BN // V4: tracks last buy/sell for inactivity
  reclaimed: boolean // V4: true if token was reclaimed
  name: number[]
  symbol: number[]
  uri: number[]
  bump: number
  // [V13] burn_vault_bump removed - treasury ATA now holds vote vault tokens
  treasury_bump: number
  bonding_target: BN // [V23] Per-token graduation target in lamports (0 = 200 SOL default)
  // V6: Migration timelock
  migration_announced_slot: BN
  pending_token_destination: PublicKey
  pending_sol_destination: PublicKey
}

export interface GlobalConfig {
  authority: PublicKey
  treasury: PublicKey
  dev_wallet: PublicKey // V8: receives 25% of treasury fee
  _deprecated_platform_treasury: PublicKey // V4: deprecated V3.2 — merged into protocol treasury
  protocol_fee_bps: number
  paused: boolean
  total_tokens_launched: BN
  total_volume_sol: BN
  bump: number
}

export interface Treasury {
  bonding_curve: PublicKey
  mint: PublicKey
  sol_balance: BN
  total_bought_back: BN
  total_burned_from_buyback: BN
  tokens_held: BN
  last_buyback_slot: BN
  buyback_count: BN
  harvested_fees: BN
  // V9: Auto-buyback configuration
  baseline_sol_reserves: BN
  baseline_token_reserves: BN
  ratio_threshold_bps: number
  reserve_ratio_bps: number
  buyback_percent_bps: number
  min_buyback_interval_slots: BN
  baseline_initialized: boolean
  // V10: Star token tracking
  total_stars: BN
  star_sol_balance: BN
  creator_paid_out: boolean
  bump: number
}

// V2.0: Torch Vault (on-chain state)
export interface TorchVault {
  creator: PublicKey
  authority: PublicKey
  sol_balance: BN
  total_deposited: BN
  total_withdrawn: BN
  total_spent: BN
  total_received: BN
  linked_wallets: number
  created_at: BN
  bump: number
}

// V2.0: Vault wallet link (on-chain state)
export interface VaultWalletLink {
  vault: PublicKey
  wallet: PublicKey
  linked_at: BN
  bump: number
}

// V2.4: Per-user, per-token loan position for treasury lending
export interface LoanPosition {
  user: PublicKey
  mint: PublicKey
  collateral_amount: BN
  borrowed_amount: BN
  accrued_interest: BN
  last_update_slot: BN
  bump: number
}

// Helper to decode byte arrays to strings
export const decodeString = (bytes: number[]): string => {
  return Buffer.from(bytes).toString('utf8').replace(/\0/g, '')
}

// PDA derivation helpers
export const getGlobalConfigPda = (): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync([Buffer.from(GLOBAL_CONFIG_SEED)], PROGRAM_ID)
}

export const getBondingCurvePda = (mint: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(BONDING_CURVE_SEED), mint.toBuffer()],
    PROGRAM_ID,
  )
}

// [V13] Treasury's token account (ATA) - holds vote vault tokens during bonding
export const getTreasuryTokenAccount = (mint: PublicKey, treasury: PublicKey): PublicKey => {
  return getAssociatedTokenAddressSync(
    mint,
    treasury,
    true, // allowOwnerOffCurve (PDA)
    TOKEN_2022_PROGRAM_ID,
  )
}

export const getUserPositionPda = (
  bondingCurve: PublicKey,
  user: PublicKey,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(USER_POSITION_SEED), bondingCurve.toBuffer(), user.toBuffer()],
    PROGRAM_ID,
  )
}

export const getVoteRecordPda = (
  bondingCurve: PublicKey,
  voter: PublicKey,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VOTE_SEED), bondingCurve.toBuffer(), voter.toBuffer()],
    PROGRAM_ID,
  )
}

export const getTokenTreasuryPda = (mint: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync([Buffer.from(TREASURY_SEED), mint.toBuffer()], PROGRAM_ID)
}

// V11: Protocol treasury PDA
export const getProtocolTreasuryPda = (): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_TREASURY_SEED)], PROGRAM_ID)
}

// V4: User stats PDA
export const getUserStatsPda = (user: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(USER_STATS_SEED), user.toBuffer()],
    PROGRAM_ID,
  )
}

// V10: Star record PDA (per user-token, not user-creator)
export const getStarRecordPda = (
  user: PublicKey,
  mint: PublicKey, // V10: Stars are per-token
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(STAR_RECORD_SEED), user.toBuffer(), mint.toBuffer()],
    PROGRAM_ID,
  )
}

// V2.4: Loan position PDA (per user-token)
export const getLoanPositionPda = (mint: PublicKey, borrower: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(LOAN_SEED), mint.toBuffer(), borrower.toBuffer()],
    PROGRAM_ID,
  )
}

// V2.4: Collateral vault PDA (per token)
export const getCollateralVaultPda = (mint: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(COLLATERAL_VAULT_SEED), mint.toBuffer()],
    PROGRAM_ID,
  )
}

// V2.0: Torch Vault PDA (per creator)
export const getTorchVaultPda = (creator: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(TORCH_VAULT_SEED), creator.toBuffer()],
    PROGRAM_ID,
  )
}

// V2.0: Vault Wallet Link PDA (per wallet)
export const getVaultWalletLinkPda = (wallet: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_WALLET_LINK_SEED), wallet.toBuffer()],
    PROGRAM_ID,
  )
}

// Get program instance
export const getProgram = (provider: AnchorProvider): Program => {
  return new Program(idl as unknown, provider)
}

// [V25] Flat treasury SOL rate: 20% → 5% across all tiers (reverted from V24 tiered fees)
const TREASURY_SOL_MAX_BPS = 2000 // 20% at start
const TREASURY_SOL_MIN_BPS = 500  // 5% at completion

// Calculate tokens out for a given SOL amount (V2.3: dynamic treasury rate, V24: tiered)
export const calculateTokensOut = (
  solAmount: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
  realSolReserves: bigint = BigInt(0), // V2.3: needed for dynamic rate calculation
  protocolFeeBps: number = 100, // 1% protocol fee (75% protocol treasury, 25% dev)
  treasuryFeeBps: number = 100, // 1% treasury fee
  bondingTarget: bigint = BigInt('200000000000'), // [V24] per-token target (0 = 200 SOL)
): {
  tokensOut: bigint
  tokensToUser: bigint
  tokensToCommunity: bigint // 10% to community treasury (vote vault)
  protocolFee: bigint
  treasuryFee: bigint
  solToCurve: bigint
  solToTreasury: bigint
  treasuryRateBps: number // V2.3: the dynamic rate used
} => {
  // Calculate protocol fee (1%)
  const protocolFee = (solAmount * BigInt(protocolFeeBps)) / BigInt(10000)
  // Calculate treasury fee (1%)
  const treasuryFee = (solAmount * BigInt(treasuryFeeBps)) / BigInt(10000)
  const solAfterFees = solAmount - protocolFee - treasuryFee

  // [V25] Flat 20% → 5% treasury rate across all tiers
  const resolvedTarget = bondingTarget === BigInt(0) ? BigInt('200000000000') : bondingTarget

  // V2.3: Dynamic treasury rate - decays from 20% to 5% as bonding progresses
  const rateRange = BigInt(TREASURY_SOL_MAX_BPS - TREASURY_SOL_MIN_BPS)
  const decay = (realSolReserves * rateRange) / resolvedTarget
  const treasuryRateBps = Math.max(TREASURY_SOL_MAX_BPS - Number(decay), TREASURY_SOL_MIN_BPS)

  // Split remaining SOL using dynamic rate
  const solToTreasurySplit = (solAfterFees * BigInt(treasuryRateBps)) / BigInt(10000)
  const solToCurve = solAfterFees - solToTreasurySplit

  // Total to treasury = flat fee + dynamic split
  const solToTreasury = treasuryFee + solToTreasurySplit

  // Calculate tokens using constant product formula (based on SOL going to curve)
  const tokensOut = (virtualTokenReserves * solToCurve) / (virtualSolReserves + solToCurve)

  // Split tokens: 90% to user, 10% to community treasury
  // No permanent burn during bonding - community votes on treasury tokens at migration
  const tokensToUser = (tokensOut * BigInt(9000)) / BigInt(10000)
  const tokensToCommunity = tokensOut - tokensToUser

  return {
    tokensOut,
    tokensToUser,
    tokensToCommunity,
    protocolFee,
    treasuryFee,
    solToCurve,
    solToTreasury,
    treasuryRateBps,
  }
}

// Calculate SOL out for a given token amount (no sell fee)
export const calculateSolOut = (
  tokenAmount: bigint,
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): { solOut: bigint; solToUser: bigint } => {
  // Calculate SOL using inverse formula
  const solOut = (virtualSolReserves * tokenAmount) / (virtualTokenReserves + tokenAmount)

  // No fees on sells - user gets full amount
  return { solOut, solToUser: solOut }
}

// Calculate current token price in SOL
export const calculatePrice = (
  virtualSolReserves: bigint,
  virtualTokenReserves: bigint,
): number => {
  // Price = virtualSol / virtualTokens
  return Number(virtualSolReserves) / Number(virtualTokenReserves)
}

// Calculate bonding progress percentage
export const calculateBondingProgress = (realSolReserves: bigint): number => {
  const target = BigInt('200000000000') // 200 SOL in lamports
  if (realSolReserves >= target) return 100
  return (Number(realSolReserves) / Number(target)) * 100
}

// ============================================================================
// RAYDIUM CPMM PDA DERIVATION (V5)
// ============================================================================

// Order tokens for Raydium (token_0 < token_1 by pubkey bytes)
export const orderTokensForRaydium = (
  tokenA: PublicKey,
  tokenB: PublicKey,
): { token0: PublicKey; token1: PublicKey; isToken0First: boolean } => {
  const aBytes = tokenA.toBuffer()
  const bBytes = tokenB.toBuffer()

  for (let i = 0; i < 32; i++) {
    if (aBytes[i] < bBytes[i]) {
      return { token0: tokenA, token1: tokenB, isToken0First: true }
    } else if (aBytes[i] > bBytes[i]) {
      return { token0: tokenB, token1: tokenA, isToken0First: false }
    }
  }
  // Equal - shouldn't happen
  return { token0: tokenA, token1: tokenB, isToken0First: true }
}

// Raydium authority PDA
export const getRaydiumAuthorityPda = (): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('vault_and_lp_mint_auth_seed')],
    RAYDIUM_CPMM_PROGRAM,
  )
}

// Raydium pool state PDA
export const getRaydiumPoolStatePda = (
  ammConfig: PublicKey,
  token0Mint: PublicKey,
  token1Mint: PublicKey,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), ammConfig.toBuffer(), token0Mint.toBuffer(), token1Mint.toBuffer()],
    RAYDIUM_CPMM_PROGRAM,
  )
}

// Raydium LP mint PDA
export const getRaydiumLpMintPda = (poolState: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_lp_mint'), poolState.toBuffer()],
    RAYDIUM_CPMM_PROGRAM,
  )
}

// Raydium pool vault PDA
export const getRaydiumVaultPda = (
  poolState: PublicKey,
  tokenMint: PublicKey,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('pool_vault'), poolState.toBuffer(), tokenMint.toBuffer()],
    RAYDIUM_CPMM_PROGRAM,
  )
}

// Raydium observation state PDA
export const getRaydiumObservationPda = (poolState: PublicKey): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('observation'), poolState.toBuffer()],
    RAYDIUM_CPMM_PROGRAM,
  )
}

// Get all Raydium accounts needed for migration
export const getRaydiumMigrationAccounts = (
  tokenMint: PublicKey,
): {
  token0: PublicKey
  token1: PublicKey
  isWsolToken0: boolean
  raydiumAuthority: PublicKey
  poolState: PublicKey
  lpMint: PublicKey
  token0Vault: PublicKey
  token1Vault: PublicKey
  observationState: PublicKey
} => {
  const { token0, token1, isToken0First } = orderTokensForRaydium(WSOL_MINT, tokenMint)
  const isWsolToken0 = isToken0First

  const [raydiumAuthority] = getRaydiumAuthorityPda()
  const [poolState] = getRaydiumPoolStatePda(RAYDIUM_AMM_CONFIG, token0, token1)
  const [lpMint] = getRaydiumLpMintPda(poolState)
  const [token0Vault] = getRaydiumVaultPda(poolState, token0)
  const [token1Vault] = getRaydiumVaultPda(poolState, token1)
  const [observationState] = getRaydiumObservationPda(poolState)

  return {
    token0,
    token1,
    isWsolToken0,
    raydiumAuthority,
    poolState,
    lpMint,
    token0Vault,
    token1Vault,
    observationState,
  }
}
