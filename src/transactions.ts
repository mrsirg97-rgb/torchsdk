/**
 * Transaction builders
 *
 * Build unsigned transactions for buy, sell, create, star, vault, and lending.
 * Agents sign these locally and submit to the network.
 */

import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Keypair,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import { BN, Program, AnchorProvider, Wallet } from '@coral-xyz/anchor'
import {
  getBondingCurvePda,
  getTokenTreasuryPda,
  getTreasuryTokenAccount,
  getUserPositionPda,
  getUserStatsPda,
  getGlobalConfigPda,
  getProtocolTreasuryPda,
  getStarRecordPda,
  getLoanPositionPda,
  getCollateralVaultPda,
  getTorchVaultPda,
  getVaultWalletLinkPda,
  getRaydiumMigrationAccounts,
  calculateTokensOut,
  calculateSolOut,
  GlobalConfig,
} from './program'
import { PROGRAM_ID, MEMO_PROGRAM_ID } from './constants'
import { fetchTokenRaw } from './tokens'
import {
  BuyParams,
  SellParams,
  CreateTokenParams,
  StarParams,
  BorrowParams,
  RepayParams,
  LiquidateParams,
  CreateVaultParams,
  DepositVaultParams,
  WithdrawVaultParams,
  LinkWalletParams,
  UnlinkWalletParams,
  TransferAuthorityParams,
  TransactionResult,
  CreateTokenResult,
} from './types'
import idl from './torch_market.json'

// ============================================================================
// Helpers
// ============================================================================

const makeDummyProvider = (connection: Connection, payer: PublicKey): AnchorProvider => {
  const dummyWallet = {
    publicKey: payer,
    signTransaction: async (t: Transaction) => t,
    signAllTransactions: async (t: Transaction[]) => t,
  }
  return new AnchorProvider(connection, dummyWallet as unknown as Wallet, {})
}

const finalizeTransaction = async (
  connection: Connection,
  tx: Transaction,
  feePayer: PublicKey,
): Promise<void> => {
  const { blockhash } = await connection.getLatestBlockhash()
  tx.recentBlockhash = blockhash
  tx.feePayer = feePayer
}

// ============================================================================
// Buy
// ============================================================================

/**
 * Build an unsigned buy transaction.
 *
 * When `params.vault` is provided, the vault pays for the buy (vault creator pubkey).
 * When omitted, the buyer pays from their own wallet (backward compatible).
 *
 * @param connection - Solana RPC connection
 * @param params - Buy parameters (mint, buyer, amount_sol in lamports, optional vault, slippage_bps, vote)
 * @returns Unsigned transaction and descriptive message
 */
export const buildBuyTransaction = async (
  connection: Connection,
  params: BuyParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, buyer: buyerStr, amount_sol, slippage_bps = 100, vote, message, vault: vaultCreatorStr } = params

  const mint = new PublicKey(mintStr)
  const buyer = new PublicKey(buyerStr)

  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)

  const { bondingCurve } = tokenData
  if (bondingCurve.bonding_complete) throw new Error('Bonding curve complete, trade on DEX')

  // Calculate expected output
  const virtualSol = BigInt(bondingCurve.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bondingCurve.virtual_token_reserves.toString())
  const realSol = BigInt(bondingCurve.real_sol_reserves.toString())
  const solAmount = BigInt(amount_sol)

  const result = calculateTokensOut(solAmount, virtualSol, virtualTokens, realSol)

  // Apply slippage
  const slippage = Math.max(10, Math.min(1000, slippage_bps))
  const minTokens = (result.tokensToUser * BigInt(10000 - slippage)) / BigInt(10000)

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const [userPositionPda] = getUserPositionPda(bondingCurvePda, buyer)
  const [userStatsPda] = getUserStatsPda(buyer)
  const [globalConfigPda] = getGlobalConfigPda()
  const [protocolTreasuryPda] = getProtocolTreasuryPda()

  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint,
    bondingCurvePda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const treasuryTokenAccount = getTreasuryTokenAccount(mint, treasuryPda)
  const buyerTokenAccount = getAssociatedTokenAddressSync(mint, buyer, false, TOKEN_2022_PROGRAM_ID)

  const tx = new Transaction()

  // Create buyer ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      buyer,
      buyerTokenAccount,
      buyer,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  const provider = makeDummyProvider(connection, buyer)
  const program = new Program(idl as unknown, provider)

  // Fetch global config for dev wallet
  const globalConfigAccount = (await (program.account as any).globalConfig.fetch(
    globalConfigPda,
  )) as GlobalConfig

  // Vault accounts (optional — pass null when not using vault)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(buyer)
  }

  const buyIx = await program.methods
    .buy({
      solAmount: new BN(amount_sol.toString()),
      minTokensOut: new BN(minTokens.toString()),
      vote: vote === 'return' ? true : vote === 'burn' ? false : null,
    })
    .accounts({
      buyer,
      globalConfig: globalConfigPda,
      devWallet: (globalConfigAccount as any).devWallet || globalConfigAccount.dev_wallet,
      protocolTreasury: protocolTreasuryPda,
      mint,
      bondingCurve: bondingCurvePda,
      tokenVault: bondingCurveTokenAccount,
      tokenTreasury: treasuryPda,
      treasuryTokenAccount,
      buyerTokenAccount,
      userPosition: userPositionPda,
      userStats: userStatsPda,
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(buyIx)

  // Bundle optional message as SPL Memo instruction
  if (message && message.trim().length > 0) {
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message must be ${MAX_MESSAGE_LENGTH} characters or less`)
    }
    const memoIx = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: buyer, isSigner: true, isWritable: false }],
      data: Buffer.from(message.trim(), 'utf-8'),
    })
    tx.add(memoIx)
  }

  await finalizeTransaction(connection, tx, buyer)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Buy ${Number(result.tokensToUser) / 1e6} tokens for ${Number(solAmount) / 1e9} SOL${vaultLabel}`,
  }
}

// ============================================================================
// Sell
// ============================================================================

/**
 * Build an unsigned sell transaction.
 *
 * @param connection - Solana RPC connection
 * @param params - Sell parameters (mint, seller, amount_tokens in raw units, optional slippage_bps)
 * @returns Unsigned transaction and descriptive message
 */
export const buildSellTransaction = async (
  connection: Connection,
  params: SellParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, seller: sellerStr, amount_tokens, slippage_bps = 100, message } = params

  const mint = new PublicKey(mintStr)
  const seller = new PublicKey(sellerStr)

  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)

  const { bondingCurve } = tokenData
  if (bondingCurve.bonding_complete) throw new Error('Bonding curve complete, trade on DEX')

  // Calculate expected output
  const virtualSol = BigInt(bondingCurve.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bondingCurve.virtual_token_reserves.toString())
  const tokenAmount = BigInt(amount_tokens)

  const result = calculateSolOut(tokenAmount, virtualSol, virtualTokens)

  // Apply slippage
  const slippage = Math.max(10, Math.min(1000, slippage_bps))
  const minSol = (result.solToUser * BigInt(10000 - slippage)) / BigInt(10000)

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const [userPositionPda] = getUserPositionPda(bondingCurvePda, seller)
  const [userStatsPda] = getUserStatsPda(seller)

  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint,
    bondingCurvePda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const sellerTokenAccount = getAssociatedTokenAddressSync(mint, seller, false, TOKEN_2022_PROGRAM_ID)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, seller)
  const program = new Program(idl as unknown, provider)

  const sellIx = await program.methods
    .sell({
      tokenAmount: new BN(amount_tokens.toString()),
      minSolOut: new BN(minSol.toString()),
    })
    .accounts({
      seller,
      mint,
      bondingCurve: bondingCurvePda,
      tokenVault: bondingCurveTokenAccount,
      sellerTokenAccount,
      userPosition: userPositionPda,
      tokenTreasury: treasuryPda,
      userStats: userStatsPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  tx.add(sellIx)

  // Bundle optional message as SPL Memo instruction
  if (message && message.trim().length > 0) {
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message must be ${MAX_MESSAGE_LENGTH} characters or less`)
    }
    const memoIx = new TransactionInstruction({
      programId: MEMO_PROGRAM_ID,
      keys: [{ pubkey: seller, isSigner: true, isWritable: false }],
      data: Buffer.from(message.trim(), 'utf-8'),
    })
    tx.add(memoIx)
  }

  await finalizeTransaction(connection, tx, seller)

  return {
    transaction: tx,
    message: `Sell ${Number(tokenAmount) / 1e6} tokens for ${Number(result.solToUser) / 1e9} SOL`,
  }
}

// ============================================================================
// Create Token
// ============================================================================

/**
 * Build an unsigned create token transaction.
 *
 * Returns the transaction (partially signed by the mint keypair) and the mint keypair
 * so the agent can extract the mint address.
 *
 * @param connection - Solana RPC connection
 * @param params - Create parameters (creator, name, symbol, metadata_uri)
 * @returns Partially-signed transaction, mint PublicKey, and mint Keypair
 */
export const buildCreateTokenTransaction = async (
  connection: Connection,
  params: CreateTokenParams,
): Promise<CreateTokenResult> => {
  const { creator: creatorStr, name, symbol, metadata_uri } = params

  const creator = new PublicKey(creatorStr)

  if (name.length > 32) throw new Error('Name must be 32 characters or less')
  if (symbol.length > 10) throw new Error('Symbol must be 10 characters or less')

  // Grind for vanity "tm" suffix
  let mint: Keypair
  const maxAttempts = 500_000
  let attempts = 0
  while (true) {
    mint = Keypair.generate()
    attempts++
    if (mint.publicKey.toBase58().endsWith('tm')) break
    if (attempts >= maxAttempts) break
  }

  // Derive PDAs
  const [globalConfig] = getGlobalConfigPda()
  const [bondingCurve] = getBondingCurvePda(mint.publicKey)
  const [treasury] = getTokenTreasuryPda(mint.publicKey)
  const bondingCurveTokenAccount = getAssociatedTokenAddressSync(
    mint.publicKey,
    bondingCurve,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const treasuryTokenAccount = getTreasuryTokenAccount(mint.publicKey, treasury)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, creator)
  const program = new Program(idl as unknown, provider)

  const createIx = await program.methods
    .createToken({ name, symbol, uri: metadata_uri })
    .accounts({
      creator,
      globalConfig,
      mint: mint.publicKey,
      bondingCurve,
      tokenVault: bondingCurveTokenAccount,
      treasury,
      treasuryTokenAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction()

  tx.add(createIx)
  await finalizeTransaction(connection, tx, creator)

  // Partially sign with mint keypair
  tx.partialSign(mint)

  return {
    transaction: tx,
    mint: mint.publicKey,
    mintKeypair: mint,
    message: `Create token "${name}" ($${symbol})`,
  }
}

// ============================================================================
// Star
// ============================================================================

/**
 * Build an unsigned star transaction (costs 0.05 SOL).
 *
 * @param connection - Solana RPC connection
 * @param params - Star parameters (mint, user)
 * @returns Unsigned transaction and descriptive message
 */
export const buildStarTransaction = async (
  connection: Connection,
  params: StarParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, user: userStr } = params

  const mint = new PublicKey(mintStr)
  const user = new PublicKey(userStr)

  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)

  const { bondingCurve } = tokenData

  if (user.equals(bondingCurve.creator)) {
    throw new Error('Cannot star your own token')
  }

  // Check if already starred
  const [starRecordPda] = getStarRecordPda(user, mint)
  const starRecord = await connection.getAccountInfo(starRecordPda)
  if (starRecord) throw new Error('Already starred this token')

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, user)
  const program = new Program(idl as unknown, provider)

  const starIx = await program.methods
    .starToken()
    .accounts({
      user,
      mint,
      bondingCurve: bondingCurvePda,
      tokenTreasury: treasuryPda,
      creator: bondingCurve.creator,
      starRecord: starRecordPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  tx.add(starIx)
  await finalizeTransaction(connection, tx, user)

  return {
    transaction: tx,
    message: 'Star token (costs 0.05 SOL)',
  }
}

// ============================================================================
// Message
// ============================================================================

const MAX_MESSAGE_LENGTH = 500

// ============================================================================
// Vault (V2.0)
// ============================================================================

/**
 * Build an unsigned create vault transaction.
 *
 * Creates a TorchVault PDA and auto-links the creator's wallet.
 *
 * @param connection - Solana RPC connection
 * @param params - Creator public key
 * @returns Unsigned transaction
 */
export const buildCreateVaultTransaction = async (
  connection: Connection,
  params: CreateVaultParams,
): Promise<TransactionResult> => {
  const creator = new PublicKey(params.creator)
  const [vaultPda] = getTorchVaultPda(creator)
  const [walletLinkPda] = getVaultWalletLinkPda(creator)

  const provider = makeDummyProvider(connection, creator)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .createVault()
    .accounts({
      creator,
      vault: vaultPda,
      walletLink: walletLinkPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, creator)

  return {
    transaction: tx,
    message: `Create vault for ${params.creator.slice(0, 8)}...`,
  }
}

/**
 * Build an unsigned deposit vault transaction.
 *
 * Anyone can deposit SOL into any vault.
 *
 * @param connection - Solana RPC connection
 * @param params - Depositor, vault creator, amount in lamports
 * @returns Unsigned transaction
 */
export const buildDepositVaultTransaction = async (
  connection: Connection,
  params: DepositVaultParams,
): Promise<TransactionResult> => {
  const depositor = new PublicKey(params.depositor)
  const vaultCreator = new PublicKey(params.vault_creator)
  const [vaultPda] = getTorchVaultPda(vaultCreator)

  const provider = makeDummyProvider(connection, depositor)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .depositVault(new BN(params.amount_sol.toString()))
    .accounts({
      depositor,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, depositor)

  return {
    transaction: tx,
    message: `Deposit ${params.amount_sol / 1e9} SOL into vault`,
  }
}

/**
 * Build an unsigned withdraw vault transaction.
 *
 * Only the vault authority can withdraw.
 *
 * @param connection - Solana RPC connection
 * @param params - Authority, vault creator, amount in lamports
 * @returns Unsigned transaction
 */
export const buildWithdrawVaultTransaction = async (
  connection: Connection,
  params: WithdrawVaultParams,
): Promise<TransactionResult> => {
  const authority = new PublicKey(params.authority)
  const vaultCreator = new PublicKey(params.vault_creator)
  const [vaultPda] = getTorchVaultPda(vaultCreator)

  const provider = makeDummyProvider(connection, authority)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .withdrawVault(new BN(params.amount_sol.toString()))
    .accounts({
      authority,
      vault: vaultPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, authority)

  return {
    transaction: tx,
    message: `Withdraw ${params.amount_sol / 1e9} SOL from vault`,
  }
}

/**
 * Build an unsigned link wallet transaction.
 *
 * Only the vault authority can link wallets.
 *
 * @param connection - Solana RPC connection
 * @param params - Authority, vault creator, wallet to link
 * @returns Unsigned transaction
 */
export const buildLinkWalletTransaction = async (
  connection: Connection,
  params: LinkWalletParams,
): Promise<TransactionResult> => {
  const authority = new PublicKey(params.authority)
  const vaultCreator = new PublicKey(params.vault_creator)
  const walletToLink = new PublicKey(params.wallet_to_link)
  const [vaultPda] = getTorchVaultPda(vaultCreator)
  const [walletLinkPda] = getVaultWalletLinkPda(walletToLink)

  const provider = makeDummyProvider(connection, authority)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .linkWallet()
    .accounts({
      authority,
      vault: vaultPda,
      walletToLink,
      walletLink: walletLinkPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, authority)

  return {
    transaction: tx,
    message: `Link wallet ${params.wallet_to_link.slice(0, 8)}... to vault`,
  }
}

/**
 * Build an unsigned unlink wallet transaction.
 *
 * Only the vault authority can unlink wallets. Rent returns to authority.
 *
 * @param connection - Solana RPC connection
 * @param params - Authority, vault creator, wallet to unlink
 * @returns Unsigned transaction
 */
export const buildUnlinkWalletTransaction = async (
  connection: Connection,
  params: UnlinkWalletParams,
): Promise<TransactionResult> => {
  const authority = new PublicKey(params.authority)
  const vaultCreator = new PublicKey(params.vault_creator)
  const walletToUnlink = new PublicKey(params.wallet_to_unlink)
  const [vaultPda] = getTorchVaultPda(vaultCreator)
  const [walletLinkPda] = getVaultWalletLinkPda(walletToUnlink)

  const provider = makeDummyProvider(connection, authority)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .unlinkWallet()
    .accounts({
      authority,
      vault: vaultPda,
      walletToUnlink,
      walletLink: walletLinkPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, authority)

  return {
    transaction: tx,
    message: `Unlink wallet ${params.wallet_to_unlink.slice(0, 8)}... from vault`,
  }
}

/**
 * Build an unsigned transfer authority transaction.
 *
 * Transfers vault admin control to a new wallet.
 *
 * @param connection - Solana RPC connection
 * @param params - Current authority, vault creator, new authority
 * @returns Unsigned transaction
 */
export const buildTransferAuthorityTransaction = async (
  connection: Connection,
  params: TransferAuthorityParams,
): Promise<TransactionResult> => {
  const authority = new PublicKey(params.authority)
  const vaultCreator = new PublicKey(params.vault_creator)
  const newAuthority = new PublicKey(params.new_authority)
  const [vaultPda] = getTorchVaultPda(vaultCreator)

  const provider = makeDummyProvider(connection, authority)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .transferAuthority()
    .accounts({
      authority,
      vault: vaultPda,
      newAuthority,
    })
    .instruction()

  const tx = new Transaction().add(ix)
  await finalizeTransaction(connection, tx, authority)

  return {
    transaction: tx,
    message: `Transfer vault authority to ${params.new_authority.slice(0, 8)}...`,
  }
}

// ============================================================================
// Borrow (V2.4)
// ============================================================================

/**
 * Build an unsigned borrow transaction.
 *
 * Lock tokens as collateral in the collateral vault and receive SOL from treasury.
 * Token must be migrated (has Raydium pool for price calculation).
 *
 * @param connection - Solana RPC connection
 * @param params - Borrow parameters (mint, borrower, collateral_amount, sol_to_borrow)
 * @returns Unsigned transaction and descriptive message
 */
export const buildBorrowTransaction = async (
  connection: Connection,
  params: BorrowParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, borrower: borrowerStr, collateral_amount, sol_to_borrow } = params

  const mint = new PublicKey(mintStr)
  const borrower = new PublicKey(borrowerStr)

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const [collateralVaultPda] = getCollateralVaultPda(mint)
  const [loanPositionPda] = getLoanPositionPda(mint, borrower)

  const borrowerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    borrower,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  // Get Raydium pool accounts for price calculation
  const raydium = getRaydiumMigrationAccounts(mint)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, borrower)
  const program = new Program(idl as unknown, provider)

  const borrowIx = await program.methods
    .borrow({
      collateralAmount: new BN(collateral_amount.toString()),
      solToBorrow: new BN(sol_to_borrow.toString()),
    })
    .accounts({
      borrower,
      mint,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      collateralVault: collateralVaultPda,
      borrowerTokenAccount,
      loanPosition: loanPositionPda,
      poolState: raydium.poolState,
      tokenVault0: raydium.token0Vault,
      tokenVault1: raydium.token1Vault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  tx.add(borrowIx)
  await finalizeTransaction(connection, tx, borrower)

  return {
    transaction: tx,
    message: `Borrow ${Number(sol_to_borrow) / 1e9} SOL with ${Number(collateral_amount) / 1e6} tokens as collateral`,
  }
}

// ============================================================================
// Repay (V2.4)
// ============================================================================

/**
 * Build an unsigned repay transaction.
 *
 * Repay SOL debt. Interest is paid first, then principal.
 * Full repay returns all collateral and closes the position.
 *
 * @param connection - Solana RPC connection
 * @param params - Repay parameters (mint, borrower, sol_amount)
 * @returns Unsigned transaction and descriptive message
 */
export const buildRepayTransaction = async (
  connection: Connection,
  params: RepayParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, borrower: borrowerStr, sol_amount } = params

  const mint = new PublicKey(mintStr)
  const borrower = new PublicKey(borrowerStr)

  // Derive PDAs
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const [collateralVaultPda] = getCollateralVaultPda(mint)
  const [loanPositionPda] = getLoanPositionPda(mint, borrower)

  const borrowerTokenAccount = getAssociatedTokenAddressSync(
    mint,
    borrower,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, borrower)
  const program = new Program(idl as unknown, provider)

  const repayIx = await program.methods
    .repay(new BN(sol_amount.toString()))
    .accounts({
      borrower,
      mint,
      treasury: treasuryPda,
      collateralVault: collateralVaultPda,
      borrowerTokenAccount,
      loanPosition: loanPositionPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  tx.add(repayIx)
  await finalizeTransaction(connection, tx, borrower)

  return {
    transaction: tx,
    message: `Repay ${Number(sol_amount) / 1e9} SOL`,
  }
}

// ============================================================================
// Liquidate (V2.4)
// ============================================================================

/**
 * Build an unsigned liquidate transaction.
 *
 * Permissionless — anyone can call when a borrower's LTV exceeds the
 * liquidation threshold. Liquidator pays SOL and receives collateral + bonus.
 *
 * @param connection - Solana RPC connection
 * @param params - Liquidate parameters (mint, liquidator, borrower)
 * @returns Unsigned transaction and descriptive message
 */
export const buildLiquidateTransaction = async (
  connection: Connection,
  params: LiquidateParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, liquidator: liquidatorStr, borrower: borrowerStr } = params

  const mint = new PublicKey(mintStr)
  const liquidator = new PublicKey(liquidatorStr)
  const borrower = new PublicKey(borrowerStr)

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const [collateralVaultPda] = getCollateralVaultPda(mint)
  const [loanPositionPda] = getLoanPositionPda(mint, borrower)

  const liquidatorTokenAccount = getAssociatedTokenAddressSync(
    mint,
    liquidator,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  // Get Raydium pool accounts for price calculation
  const raydium = getRaydiumMigrationAccounts(mint)

  const tx = new Transaction()

  // Create liquidator ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      liquidator,
      liquidatorTokenAccount,
      liquidator,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  const provider = makeDummyProvider(connection, liquidator)
  const program = new Program(idl as unknown, provider)

  const liquidateIx = await program.methods
    .liquidate()
    .accounts({
      liquidator,
      borrower,
      mint,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      collateralVault: collateralVaultPda,
      liquidatorTokenAccount,
      loanPosition: loanPositionPda,
      poolState: raydium.poolState,
      tokenVault0: raydium.token0Vault,
      tokenVault1: raydium.token1Vault,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  tx.add(liquidateIx)
  await finalizeTransaction(connection, tx, liquidator)

  return {
    transaction: tx,
    message: `Liquidate loan position for ${borrowerStr}`,
  }
}
