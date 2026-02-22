import { PublicKey } from '@solana/web3.js'

// Program ID - Mainnet/Devnet (deployed program)
export const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')

// Network detection: evaluated at call time so env can be set dynamically.
// Checks globalThis.__TORCH_NETWORK__ first (for browser runtime switching),
// then falls back to process.env.TORCH_NETWORK (for Node.js / build-time).
const isDevnet = (): boolean =>
  (globalThis as any).__TORCH_NETWORK__ === 'devnet' ||
  (typeof process !== 'undefined' && process.env?.TORCH_NETWORK === 'devnet')

// Raydium CPMM Program (different on mainnet vs devnet)
export const getRaydiumCpmmProgram = () => new PublicKey(
  isDevnet()
    ? 'CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW'
    : 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C'
)
/** @deprecated Use getRaydiumCpmmProgram() for dynamic network support */
export const RAYDIUM_CPMM_PROGRAM = getRaydiumCpmmProgram()

// WSOL Mint (same on all networks)
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

// Raydium AMM Config (different on mainnet vs devnet)
export const getRaydiumAmmConfig = () => new PublicKey(
  isDevnet()
    ? '9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6'
    : 'D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2'
)
/** @deprecated Use getRaydiumAmmConfig() for dynamic network support */
export const RAYDIUM_AMM_CONFIG = getRaydiumAmmConfig()

// Raydium Fee Receiver (different on mainnet vs devnet)
export const getRaydiumFeeReceiver = () => new PublicKey(
  isDevnet()
    ? 'G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2'
    : 'DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8'
)
/** @deprecated Use getRaydiumFeeReceiver() for dynamic network support */
export const RAYDIUM_FEE_RECEIVER = getRaydiumFeeReceiver()

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
export const PROTOCOL_TREASURY_SEED = 'protocol_treasury_v11' // V11: Protocol fee treasury
export const USER_STATS_SEED = 'user_stats'
export const STAR_RECORD_SEED = 'star_record'
export const LOAN_SEED = 'loan'
export const COLLATERAL_VAULT_SEED = 'collateral_vault'
export const TORCH_VAULT_SEED = 'torch_vault' // V2.0: Vault PDA
export const VAULT_WALLET_LINK_SEED = 'vault_wallet' // V2.0: Wallet link PDA
export const TREASURY_LOCK_SEED = 'treasury_lock' // V27: Treasury lock PDA

// Token constants (must match the Rust program)
export const TOTAL_SUPPLY = BigInt('1000000000000000') // 1B with 6 decimals
export const TOKEN_DECIMALS = 6

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
  'GawKda5Vzm34HaDCkQrCLjnGUaQFVuYcTFpkDstNBRtm', // Failed mainnet token (relaunched)
]

// Formatting helpers
export const LAMPORTS_PER_SOL = 1_000_000_000
export const TOKEN_MULTIPLIER = Math.pow(10, TOKEN_DECIMALS)
