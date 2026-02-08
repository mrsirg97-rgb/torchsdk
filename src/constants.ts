import { PublicKey } from '@solana/web3.js'

// Program ID - Mainnet/Devnet (deployed program)
export const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')

// Raydium CPMM Program
// Note: Same address on mainnet and devnet - Raydium deploys to same program ID
export const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')

// WSOL Mint (same on all networks)
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

// Raydium AMM Config (0.25% fee tier - standard)
// Note: This config PDA exists on both mainnet and devnet
export const RAYDIUM_AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')

// Raydium pool creation fee receiver
// Note: Same address on mainnet and devnet
export const RAYDIUM_CREATE_POOL_FEE = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')

// SPL Memo Program
export const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr')

// Token-2022 Program (for Token Extensions)
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')

// PDA Seeds (must match the Rust program)
export const GLOBAL_CONFIG_SEED = 'global_config'
export const BONDING_CURVE_SEED = 'bonding_curve'
// [V13] BURN_VAULT_SEED removed - treasury's ATA now holds vote vault tokens
export const TREASURY_SEED = 'treasury'
export const USER_POSITION_SEED = 'user_position'
export const VOTE_SEED = 'vote'
export const PLATFORM_TREASURY_SEED = 'platform_treasury'
export const PROTOCOL_TREASURY_SEED = 'protocol_treasury_v11' // V11: Protocol fee treasury
export const USER_STATS_SEED = 'user_stats'
export const STAR_RECORD_SEED = 'star_record'
export const LOAN_SEED = 'loan'
export const COLLATERAL_VAULT_SEED = 'collateral_vault'

// Token constants (must match the Rust program)
export const TOTAL_SUPPLY = BigInt('1000000000000000') // 1B with 6 decimals
export const MAX_WALLET_TOKENS = BigInt('20000000000000') // 2% of supply
// [V2.2] 10% to community treasury, 90% to buyer
// Community votes on whether to burn or return these tokens on migration
export const BURN_RATE_BPS = 1000 // 10% to community treasury
export const TREASURY_SOL_BPS = 2000 // 20% of buy SOL (after fees) to treasury
export const TREASURY_FEE_BPS = 100 // 1% flat treasury fee on buys
export const SELL_FEE_BPS = 0 // No sell fee
export const BONDING_TARGET_LAMPORTS = BigInt('200000000000') // 200 SOL
export const TOKEN_DECIMALS = 6
export const INITIAL_VIRTUAL_SOL = BigInt('30000000000') // 30 SOL
export const INITIAL_VIRTUAL_TOKENS = BigInt('107300000000000') // Scaled for 1B supply
export const PROTOCOL_FEE_BPS = 100 // 1% (V11)
export const MIN_SOL_AMOUNT = BigInt('1000000') // 0.001 SOL
export const VOTING_DURATION_SLOTS = BigInt('216000') // ~24 hours

// V4: Failed token reclaim and platform rewards
// V12: Reduced from 60 days to 7 days (1 epoch)
export const INACTIVITY_PERIOD_SLOTS = BigInt((7 * 24 * 60 * 60 * 1000) / 400) // ~7 days in slots
export const EPOCH_DURATION_SECONDS = 7 * 24 * 60 * 60 // 7 days
export const MIN_RECLAIM_THRESHOLD = BigInt('10000000') // 0.01 SOL

// V10: Star Token
export const STAR_THRESHOLD = 2000 // Stars needed for creator auto-payout
export const STAR_COST_LAMPORTS = BigInt('50000000') // 0.05 SOL per star

// V11: Protocol Treasury
export const PROTOCOL_TREASURY_RESERVE_FLOOR = BigInt('1500000000000') // 1500 SOL
export const MIN_EPOCH_VOLUME_ELIGIBILITY = BigInt('10000000000') // 10 SOL

// V12: Token Revival
export const REVIVAL_THRESHOLD = INITIAL_VIRTUAL_SOL // 30 SOL

// Blacklisted tokens (legacy test tokens, etc.)
export const BLACKLISTED_MINTS: string[] = [
  '6JkGdXSKzUHTNwR5w7jce4WxjczUGpqheBJsP1if5htm', // Legacy SPL test token (pre-prod-beta)
  'Nu5xbqZvZd4JerG2aNyxQfUiHBnM59w7CHzyVx5Vztm', // Legacy SPL devnet test token
  '8wzap6FUtL4ko6LnnELt8ZoM6ksy6jPJ9veFkwGB56tm', // Legacy SPL devnet test token
  'HgFGagsCFmBKRFM3U4zCpy3r8XU7RFS58UChup9xCytm', // Legacy SPL devnet test token
  'CLJk4YLy8pBu7mRFm1hfaeFJJ6WQQR7RHmkptPSLCXtm', // Pre-V13 devnet test token
  '61ryb1WAq2vqEcdeStvTMRvYdcgzvZYFjBtKzSzXv7tm', // Pre-V13 devnet test token
  '9F8SXt7VP8b6Vb6RzE8dTdBEwKuKeCizhxEY6QQX1qtm', // Pre-V13 mainnet test token
  'GQKidAtE2RmEpMq7ciPShniHZ9fh8NSAaXp59M89X3tm', // Pre-V13 mainnet test token
  '7b7WHQdXQN4bR8eC47jaH9De6JYC4cze1BWJJcxU1Mtm', // Pre-V13 mainnet test token
  'FjERW8DSNB81GYWhrXwdfS3s74xTF8T5gjcKYSa1v7tm', // Duplicate test token (keep Second Torch only)
]

// Formatting helpers
export const LAMPORTS_PER_SOL = 1_000_000_000
export const TOKEN_MULTIPLIER = Math.pow(10, TOKEN_DECIMALS)

export const formatSol = (lamports: bigint | number): string => {
  const value = Number(lamports) / LAMPORTS_PER_SOL
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })
}

export const formatTokens = (amount: bigint | number): string => {
  const value = Number(amount) / TOKEN_MULTIPLIER
  if (value >= 1_000_000_000) {
    return (value / 1_000_000_000).toFixed(2) + 'B'
  }
  if (value >= 1_000_000) {
    return (value / 1_000_000).toFixed(2) + 'M'
  }
  if (value >= 1_000) {
    return (value / 1_000).toFixed(2) + 'K'
  }
  return value.toFixed(2)
}

export const formatPercent = (value: number): string => (value * 100).toFixed(2) + '%'

export const shortenAddress = (address: string, chars = 4): string =>
  `${address.slice(0, chars)}...${address.slice(-chars)}`

// Estimate time from slot difference (Solana ~400ms per slot)
const MS_PER_SLOT = 400

export const formatSlotAge = (slot: bigint, currentSlot: bigint): string => {
  const slotDiff = currentSlot - slot
  if (slotDiff <= BigInt(0)) return 'Just now'

  const msAgo = Number(slotDiff) * MS_PER_SLOT
  const seconds = Math.floor(msAgo / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) return `${days}d ago`
  if (hours > 0) return `${hours}h ago`
  if (minutes > 0) return `${minutes}m ago`
  return 'Just now'
}
