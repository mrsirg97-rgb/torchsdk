/**
 * @torch-market/sdk
 *
 * AI agent toolkit for Solana fair-launch tokens.
 *
 * Usage:
 *   import { getTokens, buildBuyTransaction } from "@torch-market/sdk";
 *   const connection = new Connection("https://api.mainnet-beta.solana.com");
 *   const tokens = await getTokens(connection);
 *   const tx = await buildBuyTransaction(connection, { mint, buyer, amount_sol: 100_000_000 });
 */

// Token data
export {
  getTokens,
  getToken,
  getHolders,
  getMessages,
  getLendingInfo,
  getLoanPosition,
  getVault,
  getVaultForWallet,
  getVaultWalletLink,
} from './tokens'

// Quotes
export { getBuyQuote, getSellQuote } from './quotes'

// Transaction builders
export {
  buildBuyTransaction,
  buildDirectBuyTransaction,
  buildSellTransaction,
  buildCreateTokenTransaction,
  buildStarTransaction,
  buildMigrateTransaction,
  buildBorrowTransaction,
  buildRepayTransaction,
  buildLiquidateTransaction,
  buildClaimProtocolRewardsTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildWithdrawVaultTransaction,
  buildLinkWalletTransaction,
  buildUnlinkWalletTransaction,
  buildTransferAuthorityTransaction,
  buildWithdrawTokensTransaction,
  buildVaultSwapTransaction,
  buildAutoBuybackTransaction,
  buildHarvestFeesTransaction,
  buildSwapFeesToSolTransaction,
} from './transactions'

// Ephemeral Agent
export { createEphemeralAgent } from './ephemeral'
export type { EphemeralAgent } from './ephemeral'

// SAID Protocol
export { verifySaid, confirmTransaction } from './said'

// Types
export type {
  TokenStatus,
  TokenSummary,
  TokenDetail,
  TokenSortOption,
  TokenStatusFilter,
  TokenListParams,
  TokenListResult,
  Holder,
  HoldersResult,
  BuyQuoteResult,
  SellQuoteResult,
  BuyParams,
  DirectBuyParams,
  SellParams,
  CreateTokenParams,
  StarParams,
  MigrateParams,
  TransactionResult,
  BuyTransactionResult,
  CreateTokenResult,
  BorrowParams,
  RepayParams,
  LiquidateParams,
  ClaimProtocolRewardsParams,
  LendingInfo,
  LoanPositionInfo,
  TokenMessage,
  MessagesResult,
  SaidVerification,
  ConfirmResult,
  VaultInfo,
  VaultWalletLinkInfo,
  CreateVaultParams,
  DepositVaultParams,
  WithdrawVaultParams,
  LinkWalletParams,
  UnlinkWalletParams,
  TransferAuthorityParams,
  WithdrawTokensParams,
  VaultSwapParams,
  AutoBuybackParams,
  HarvestFeesParams,
  SwapFeesToSolParams,
} from './types'

// Constants (for advanced usage)
export { PROGRAM_ID, LAMPORTS_PER_SOL, TOKEN_MULTIPLIER, TOTAL_SUPPLY } from './constants'
