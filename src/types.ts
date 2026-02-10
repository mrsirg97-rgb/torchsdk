/**
 * Torch Market SDK Types
 */

import { PublicKey, Transaction, Keypair } from '@solana/web3.js'

// ============================================================================
// Token Types
// ============================================================================

export type TokenStatus = 'bonding' | 'complete' | 'migrated'

export interface TokenSummary {
  mint: string
  name: string
  symbol: string
  status: TokenStatus
  price_sol: number
  market_cap_sol: number
  progress_percent: number
  holders: number | null
  created_at: number
}

export interface TokenDetail {
  mint: string
  name: string
  symbol: string
  description?: string
  image?: string
  status: TokenStatus
  price_sol: number
  price_usd?: number
  market_cap_sol: number
  market_cap_usd?: number
  progress_percent: number
  sol_raised: number
  sol_target: number
  total_supply: number
  circulating_supply: number
  tokens_in_curve: number
  tokens_in_vote_vault: number
  tokens_burned: number
  treasury_sol_balance: number
  treasury_token_balance: number
  total_bought_back: number
  buyback_count: number
  votes_return: number
  votes_burn: number
  creator: string
  holders: number | null
  stars: number
  created_at: number
  last_activity_at: number
  twitter?: string
  telegram?: string
  website?: string
  creator_verified?: boolean
  creator_trust_tier?: 'high' | 'medium' | 'low' | null
  creator_said_name?: string
  creator_badge_url?: string
  warnings?: string[]
}

// ============================================================================
// List Params
// ============================================================================

export type TokenSortOption = 'newest' | 'volume' | 'marketcap'
export type TokenStatusFilter = 'bonding' | 'complete' | 'migrated' | 'all'

export interface TokenListParams {
  limit?: number
  offset?: number
  status?: TokenStatusFilter
  sort?: TokenSortOption
}

export interface TokenListResult {
  tokens: TokenSummary[]
  total: number
  limit: number
  offset: number
}

// ============================================================================
// Holders
// ============================================================================

export interface Holder {
  address: string
  balance: number
  percentage: number
}

export interface HoldersResult {
  holders: Holder[]
  total_holders: number
}

// ============================================================================
// Quotes
// ============================================================================

export interface BuyQuoteResult {
  input_sol: number
  output_tokens: number
  tokens_to_user: number
  tokens_to_treasury: number
  protocol_fee_sol: number
  price_per_token_sol: number
  price_impact_percent: number
  min_output_tokens: number
}

export interface SellQuoteResult {
  input_tokens: number
  output_sol: number
  protocol_fee_sol: number
  price_per_token_sol: number
  price_impact_percent: number
  min_output_sol: number
}

// ============================================================================
// Vault Types (V2.0)
// ============================================================================

export interface VaultInfo {
  address: string
  creator: string
  authority: string
  sol_balance: number
  total_deposited: number
  total_withdrawn: number
  total_spent: number
  linked_wallets: number
  created_at: number
}

export interface VaultWalletLinkInfo {
  address: string
  vault: string
  wallet: string
  linked_at: number
}

// ============================================================================
// Vault Params (V2.0)
// ============================================================================

export interface CreateVaultParams {
  creator: string
}

export interface DepositVaultParams {
  depositor: string
  vault_creator: string
  amount_sol: number
}

export interface WithdrawVaultParams {
  authority: string
  vault_creator: string
  amount_sol: number
}

export interface LinkWalletParams {
  authority: string
  vault_creator: string
  wallet_to_link: string
}

export interface UnlinkWalletParams {
  authority: string
  vault_creator: string
  wallet_to_unlink: string
}

export interface TransferAuthorityParams {
  authority: string
  vault_creator: string
  new_authority: string
}

// ============================================================================
// Transaction Params
// ============================================================================

export interface BuyParams {
  mint: string
  buyer: string
  amount_sol: number
  slippage_bps?: number
  vote?: 'burn' | 'return'
  message?: string
  /** Vault creator pubkey. Vault pays for the buy. */
  vault: string
}

export interface DirectBuyParams {
  mint: string
  buyer: string
  amount_sol: number
  slippage_bps?: number
  vote?: 'burn' | 'return'
  message?: string
}

export interface SellParams {
  mint: string
  seller: string
  amount_tokens: number
  slippage_bps?: number
  message?: string
}

export interface CreateTokenParams {
  creator: string
  name: string
  symbol: string
  metadata_uri: string
}

export interface StarParams {
  mint: string
  user: string
}

// ============================================================================
// Transaction Results
// ============================================================================

export interface TransactionResult {
  transaction: Transaction
  message: string
}

export interface CreateTokenResult extends TransactionResult {
  mint: PublicKey
  mintKeypair: Keypair
}

// ============================================================================
// Lending Params (V2.4)
// ============================================================================

export interface BorrowParams {
  mint: string
  borrower: string
  collateral_amount: number
  sol_to_borrow: number
}

export interface RepayParams {
  mint: string
  borrower: string
  sol_amount: number
}

export interface LiquidateParams {
  mint: string
  liquidator: string
  borrower: string
}

// ============================================================================
// Lending Results (V2.4)
// ============================================================================

export interface LendingInfo {
  interest_rate_bps: number
  max_ltv_bps: number
  liquidation_threshold_bps: number
  liquidation_bonus_bps: number
  total_sol_lent: number | null
  active_loans: number | null
  treasury_sol_available: number
  warnings?: string[]
}

export interface LoanPositionInfo {
  collateral_amount: number
  borrowed_amount: number
  accrued_interest: number
  total_owed: number
  collateral_value_sol: number | null
  current_ltv_bps: number | null
  health: 'healthy' | 'at_risk' | 'liquidatable' | 'none'
  warnings?: string[]
}

// ============================================================================
// Messages
// ============================================================================

export interface TokenMessage {
  signature: string
  memo: string
  sender: string
  timestamp: number
  sender_verified?: boolean
  sender_trust_tier?: 'high' | 'medium' | 'low' | null
  sender_said_name?: string
  sender_badge_url?: string
}

export interface MessagesResult {
  messages: TokenMessage[]
  total: number
}

// ============================================================================
// SAID
// ============================================================================

export interface SaidVerification {
  verified: boolean
  trustTier: 'high' | 'medium' | 'low' | null
  name?: string
}

export interface ConfirmResult {
  confirmed: boolean
  event_type: 'token_launch' | 'trade_complete' | 'governance_vote' | 'unknown'
}
