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
  ComputeBudgetProgram,
  Keypair,
} from '@solana/web3.js'
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  unpackAccount,
  getTransferFeeAmount,
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
  getTreasuryLockPda,
  getTreasuryLockTokenAccount,
  getRaydiumMigrationAccounts,
  calculateTokensOut,
  calculateSolOut,
  GlobalConfig,
} from './program'
import { PROGRAM_ID, MEMO_PROGRAM_ID, WSOL_MINT, getRaydiumAmmConfig, getRaydiumCpmmProgram, getRaydiumFeeReceiver } from './constants'
import { fetchTokenRaw } from './tokens'
import {
  BuyParams,
  DirectBuyParams,
  SellParams,
  CreateTokenParams,
  StarParams,
  MigrateParams,
  BorrowParams,
  RepayParams,
  LiquidateParams,
  ClaimProtocolRewardsParams,
  VaultSwapParams,
  AutoBuybackParams,
  HarvestFeesParams,
  SwapFeesToSolParams,
  CreateVaultParams,
  DepositVaultParams,
  WithdrawVaultParams,
  WithdrawTokensParams,
  LinkWalletParams,
  UnlinkWalletParams,
  TransferAuthorityParams,
  TransactionResult,
  BuyTransactionResult,
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

// Internal buy builder shared by both vault and direct variants
const buildBuyTransactionInternal = async (
  connection: Connection,
  mintStr: string,
  buyerStr: string,
  amount_sol: number,
  slippage_bps: number,
  vote: 'burn' | 'return' | undefined,
  message: string | undefined,
  vaultCreatorStr: string | undefined,
): Promise<BuyTransactionResult> => {

  const mint = new PublicKey(mintStr)
  const buyer = new PublicKey(buyerStr)

  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)

  const { bondingCurve, treasury } = tokenData
  if (bondingCurve.bonding_complete) throw new Error('Bonding curve complete, trade on DEX')

  // Calculate expected output
  const virtualSol = BigInt(bondingCurve.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bondingCurve.virtual_token_reserves.toString())
  const realSol = BigInt(bondingCurve.real_sol_reserves.toString())
  const bondingTarget = BigInt(bondingCurve.bonding_target.toString())
  const solAmount = BigInt(amount_sol)

  const result = calculateTokensOut(solAmount, virtualSol, virtualTokens, realSol, 100, 100, bondingTarget)

  // [V28] Detect if this buy will complete bonding
  const resolvedTarget = bondingTarget === BigInt(0) ? BigInt('200000000000') : bondingTarget
  const newRealSol = realSol + result.solToCurve
  const willCompleteBonding = newRealSol >= resolvedTarget

  // Apply slippage
  if (slippage_bps < 10 || slippage_bps > 1000) {
    throw new Error(`slippage_bps must be between 10 (0.1%) and 1000 (10%), got ${slippage_bps}`)
  }
  const slippage = slippage_bps
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
  let vaultTokenAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(buyer)
    // [V18] Tokens go to vault ATA instead of buyer's wallet
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      torchVaultAccount,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
    // Create vault ATA if needed (vault PDA owns it)
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        buyer,
        vaultTokenAccount,
        torchVaultAccount,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
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
      vaultTokenAccount,
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

  // [V28] Build separate migration transaction when this buy completes bonding.
  // Split into two txs because buy + migration exceeds the 1232-byte legacy limit.
  // Program handles treasury reimbursement internally, so this is just a standard migration call.
  let migrationTransaction: Transaction | undefined
  if (willCompleteBonding) {
    const migResult = await buildMigrateTransaction(connection, {
      mint: mintStr,
      payer: buyerStr,
    })
    migrationTransaction = migResult.transaction
  }

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  const migrateLabel = willCompleteBonding ? ' + migrate to DEX' : ''
  return {
    transaction: tx,
    migrationTransaction,
    message: `Buy ${Number(result.tokensToUser) / 1e6} tokens for ${Number(solAmount) / 1e9} SOL${vaultLabel}${migrateLabel}`,
  }
}

/**
 * Build an unsigned vault-funded buy transaction.
 *
 * The vault pays for the buy. This is the recommended path for AI agents.
 *
 * @param connection - Solana RPC connection
 * @param params - Buy parameters with required vault creator pubkey
 * @returns Unsigned transaction and descriptive message
 */
export const buildBuyTransaction = async (
  connection: Connection,
  params: BuyParams,
): Promise<BuyTransactionResult> => {
  const { mint, buyer, amount_sol, slippage_bps = 100, vote, message, vault } = params
  return buildBuyTransactionInternal(connection, mint, buyer, amount_sol, slippage_bps, vote, message, vault)
}

/**
 * Build an unsigned direct buy transaction (no vault).
 *
 * The buyer pays from their own wallet. Use this for human-operated wallets only.
 * For AI agents, use buildBuyTransaction with a vault instead.
 *
 * @param connection - Solana RPC connection
 * @param params - Buy parameters (no vault)
 * @returns Unsigned transaction and descriptive message
 */
export const buildDirectBuyTransaction = async (
  connection: Connection,
  params: DirectBuyParams,
): Promise<BuyTransactionResult> => {
  const { mint, buyer, amount_sol, slippage_bps = 100, vote, message } = params
  return buildBuyTransactionInternal(connection, mint, buyer, amount_sol, slippage_bps, vote, message, undefined)
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
  const { mint: mintStr, seller: sellerStr, amount_tokens, slippage_bps = 100, message, vault: vaultCreatorStr } = params

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
  if (slippage_bps < 10 || slippage_bps > 1000) {
    throw new Error(`slippage_bps must be between 10 (0.1%) and 1000 (10%), got ${slippage_bps}`)
  }
  const slippage = slippage_bps
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

  // [V18] Vault accounts (optional — pass null when not using vault)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  let vaultTokenAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(seller)
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      torchVaultAccount,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
  }

  const tx = new Transaction()

  // Create vault ATA if needed (idempotent — safe for first vault sell on a mint)
  if (vaultTokenAccount && torchVaultAccount) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        seller,
        vaultTokenAccount,
        torchVaultAccount,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
  }

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
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
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

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Sell ${Number(tokenAmount) / 1e6} tokens for ${Number(result.solToUser) / 1e9} SOL${vaultLabel}`,
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
  const { creator: creatorStr, name, symbol, metadata_uri, sol_target = 0 } = params

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
  // [V27] Treasury lock PDA and its token ATA
  const [treasuryLock] = getTreasuryLockPda(mint.publicKey)
  const treasuryLockTokenAccount = getTreasuryLockTokenAccount(mint.publicKey, treasuryLock)

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, creator)
  const program = new Program(idl as unknown, provider)

  const createIx = await program.methods
    .createToken({ name, symbol, uri: metadata_uri, solTarget: new BN(sol_target) })
    .accounts({
      creator,
      globalConfig,
      mint: mint.publicKey,
      bondingCurve,
      tokenVault: bondingCurveTokenAccount,
      treasury,
      treasuryTokenAccount,
      treasuryLock,
      treasuryLockTokenAccount,
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
  const { mint: mintStr, user: userStr, vault: vaultCreatorStr } = params

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

  // [V18] Vault accounts (optional — vault pays star cost)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(user)
  }

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
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(starIx)
  await finalizeTransaction(connection, tx, user)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Star token (costs 0.05 SOL)${vaultLabel}`,
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
  const { mint: mintStr, borrower: borrowerStr, collateral_amount, sol_to_borrow, vault: vaultCreatorStr } = params

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

  // [V18] Vault accounts (optional — collateral from vault ATA, SOL to vault)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  let vaultTokenAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(borrower)
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      torchVaultAccount,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
  }

  const tx = new Transaction()

  // Create vault ATA if needed
  if (vaultTokenAccount && torchVaultAccount) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        borrower,
        vaultTokenAccount,
        torchVaultAccount,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
  }

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
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(borrowIx)
  await finalizeTransaction(connection, tx, borrower)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Borrow ${Number(sol_to_borrow) / 1e9} SOL with ${Number(collateral_amount) / 1e6} tokens as collateral${vaultLabel}`,
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
  const { mint: mintStr, borrower: borrowerStr, sol_amount, vault: vaultCreatorStr } = params

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

  // [V18] Vault accounts (optional — SOL from vault, collateral returns to vault ATA)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  let vaultTokenAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(borrower)
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      torchVaultAccount,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
  }

  const tx = new Transaction()

  // Create vault ATA if needed (collateral returns here)
  if (vaultTokenAccount && torchVaultAccount) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        borrower,
        vaultTokenAccount,
        torchVaultAccount,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
  }

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
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(repayIx)
  await finalizeTransaction(connection, tx, borrower)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Repay ${Number(sol_amount) / 1e9} SOL${vaultLabel}`,
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
  const { mint: mintStr, liquidator: liquidatorStr, borrower: borrowerStr, vault: vaultCreatorStr } = params

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

  // [V20] Vault accounts (optional — SOL from vault, collateral to vault ATA)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  let vaultTokenAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(liquidator)
    vaultTokenAccount = getAssociatedTokenAddressSync(
      mint,
      torchVaultAccount,
      true,
      TOKEN_2022_PROGRAM_ID,
    )
  }

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

  // Create vault ATA if needed (collateral goes here)
  if (vaultTokenAccount && torchVaultAccount) {
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(
        liquidator,
        vaultTokenAccount,
        torchVaultAccount,
        mint,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
  }

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
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      vaultTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(liquidateIx)
  await finalizeTransaction(connection, tx, liquidator)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Liquidate loan position for ${borrowerStr.slice(0, 8)}...${vaultLabel}`,
  }
}

// ============================================================================
// Claim Protocol Rewards
// ============================================================================

/**
 * Build an unsigned claim protocol rewards transaction.
 *
 * Claims the user's proportional share of protocol treasury rewards
 * based on trading volume in the previous epoch. Requires >= 10 SOL volume.
 *
 * @param connection - Solana RPC connection
 * @param params - Claim parameters (user, optional vault)
 * @returns Unsigned transaction and descriptive message
 */
export const buildClaimProtocolRewardsTransaction = async (
  connection: Connection,
  params: ClaimProtocolRewardsParams,
): Promise<TransactionResult> => {
  const { user: userStr, vault: vaultCreatorStr } = params

  const user = new PublicKey(userStr)

  // Derive PDAs
  const [userStatsPda] = getUserStatsPda(user)
  const [protocolTreasuryPda] = getProtocolTreasuryPda()

  // [V20] Vault accounts (optional — rewards go to vault instead of user)
  let torchVaultAccount: PublicKey | null = null
  let vaultWalletLinkAccount: PublicKey | null = null
  if (vaultCreatorStr) {
    const vaultCreator = new PublicKey(vaultCreatorStr)
    ;[torchVaultAccount] = getTorchVaultPda(vaultCreator)
    ;[vaultWalletLinkAccount] = getVaultWalletLinkPda(user)
  }

  const tx = new Transaction()

  const provider = makeDummyProvider(connection, user)
  const program = new Program(idl as unknown, provider)

  const claimIx = await program.methods
    .claimProtocolRewards()
    .accounts({
      user,
      userStats: userStatsPda,
      protocolTreasury: protocolTreasuryPda,
      torchVault: torchVaultAccount,
      vaultWalletLink: vaultWalletLinkAccount,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(claimIx)
  await finalizeTransaction(connection, tx, user)

  const vaultLabel = vaultCreatorStr ? ' (via vault)' : ''
  return {
    transaction: tx,
    message: `Claim protocol rewards${vaultLabel}`,
  }
}

// ============================================================================
// Withdraw Tokens (V18)
// ============================================================================

/**
 * Build an unsigned withdraw tokens transaction.
 *
 * Withdraw tokens from a vault ATA to any destination token account.
 * Authority only. Composability escape hatch for external DeFi.
 *
 * @param connection - Solana RPC connection
 * @param params - Authority, vault creator, mint, destination, amount in raw units
 * @returns Unsigned transaction
 */
export const buildWithdrawTokensTransaction = async (
  connection: Connection,
  params: WithdrawTokensParams,
): Promise<TransactionResult> => {
  const authority = new PublicKey(params.authority)
  const vaultCreator = new PublicKey(params.vault_creator)
  const mint = new PublicKey(params.mint)
  const destination = new PublicKey(params.destination)

  const [vaultPda] = getTorchVaultPda(vaultCreator)

  const vaultTokenAccount = getAssociatedTokenAddressSync(
    mint,
    vaultPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  const destinationTokenAccount = getAssociatedTokenAddressSync(
    mint,
    destination,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  const tx = new Transaction()

  // Create destination ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      authority,
      destinationTokenAccount,
      destination,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  const provider = makeDummyProvider(connection, authority)
  const program = new Program(idl as unknown, provider)

  const ix = await program.methods
    .withdrawTokens(new BN(params.amount.toString()))
    .accounts({
      authority,
      vault: vaultPda,
      mint,
      vaultTokenAccount,
      destinationTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  tx.add(ix)
  await finalizeTransaction(connection, tx, authority)

  return {
    transaction: tx,
    message: `Withdraw ${params.amount} tokens from vault to ${params.destination.slice(0, 8)}...`,
  }
}

// ============================================================================
// Vault Swap (V19)
// ============================================================================

// ============================================================================
// Migration (V26)
// ============================================================================

/**
 * Build an unsigned migration transaction.
 *
 * Permissionless — anyone can call once bonding completes and vote is finalized.
 * Combines fund_migration_wsol + migrate_to_dex in a single transaction.
 * Creates a Raydium CPMM pool with locked liquidity (LP tokens burned).
 *
 * [V28] Payer fronts ~1 SOL for Raydium costs (pool creation fee + account rent).
 * Treasury reimburses the exact cost in the same transaction. Net payer cost: 0 SOL.
 *
 * Prefer using buildBuyTransaction — it auto-bundles migration when the buy
 * completes bonding, so callers don't need to call this separately.
 *
 * @param connection - Solana RPC connection
 * @param params - Migration parameters (mint, payer)
 * @returns Unsigned transaction and descriptive message
 */
export const buildMigrateTransaction = async (
  connection: Connection,
  params: MigrateParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, payer: payerStr } = params

  const mint = new PublicKey(mintStr)
  const payer = new PublicKey(payerStr)

  // Derive PDAs
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [globalConfigPda] = getGlobalConfigPda()
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const treasuryTokenAccount = getTreasuryTokenAccount(mint, treasuryPda)

  // Token vault = bonding curve's Token-2022 ATA
  const tokenVault = getAssociatedTokenAddressSync(
    mint,
    bondingCurvePda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )

  // Bonding curve's WSOL ATA (SPL Token, not Token-2022)
  const bcWsol = getAssociatedTokenAddressSync(
    WSOL_MINT,
    bondingCurvePda,
    true,
    TOKEN_PROGRAM_ID,
  )

  // Payer's WSOL ATA
  const payerWsol = getAssociatedTokenAddressSync(WSOL_MINT, payer, false, TOKEN_PROGRAM_ID)

  // Payer's token ATA (Token-2022)
  const payerToken = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID)

  // Raydium accounts
  const raydium = getRaydiumMigrationAccounts(mint)
  const payerLpToken = getAssociatedTokenAddressSync(raydium.lpMint, payer, false, TOKEN_PROGRAM_ID)

  const tx = new Transaction()

  // Compute budget — migration is heavy
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))

  // Create ATAs: bc_wsol, payer_wsol, payer_token
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer, bcWsol, bondingCurvePda, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer, payerWsol, payer, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer, payerToken, payer, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // Build program instructions
  const provider = makeDummyProvider(connection, payer)
  const program = new Program(idl as unknown, provider)

  // Step 1: Fund bonding curve's WSOL ATA (direct lamport manipulation, no CPI)
  const fundIx = await program.methods
    .fundMigrationWsol()
    .accounts({
      payer,
      mint,
      bondingCurve: bondingCurvePda,
      bcWsol,
    } as any)
    .instruction()

  // Step 2: Migrate to DEX (all CPI-based)
  const migrateIx = await program.methods
    .migrateToDex()
    .accounts({
      payer,
      globalConfig: globalConfigPda,
      mint,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      tokenVault,
      treasuryTokenAccount,
      bcWsol,
      payerWsol,
      payerToken,
      raydiumProgram: getRaydiumCpmmProgram(),
      ammConfig: getRaydiumAmmConfig(),
      raydiumAuthority: raydium.raydiumAuthority,
      poolState: raydium.poolState,
      wsolMint: WSOL_MINT,
      token0Vault: raydium.token0Vault,
      token1Vault: raydium.token1Vault,
      lpMint: raydium.lpMint,
      payerLpToken,
      observationState: raydium.observationState,
      createPoolFee: getRaydiumFeeReceiver(),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    } as any)
    .instruction()

  tx.add(fundIx, migrateIx)
  await finalizeTransaction(connection, tx, payer)

  return {
    transaction: tx,
    message: `Migrate token ${mintStr.slice(0, 8)}... to Raydium DEX`,
  }
}

// ============================================================================
// Vault Swap (V19)
// ============================================================================

/**
 * Build an unsigned vault-routed DEX swap transaction.
 *
 * Executes a Raydium CPMM swap through the vault PDA for migrated Torch tokens.
 * Full custody preserved — all value flows through the vault.
 *
 * @param connection - Solana RPC connection
 * @param params - Swap parameters (mint, signer, vault_creator, amount_in, minimum_amount_out, is_buy)
 * @returns Unsigned transaction and descriptive message
 */
export const buildVaultSwapTransaction = async (
  connection: Connection,
  params: VaultSwapParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, signer: signerStr, vault_creator: vaultCreatorStr, amount_in, minimum_amount_out, is_buy } = params

  const mint = new PublicKey(mintStr)
  const signer = new PublicKey(signerStr)
  const vaultCreator = new PublicKey(vaultCreatorStr)

  // Derive vault PDAs
  const [torchVaultPda] = getTorchVaultPda(vaultCreator)
  const [vaultWalletLinkPda] = getVaultWalletLinkPda(signer)
  const [bondingCurvePda] = getBondingCurvePda(mint)

  // Vault's token ATA (Token-2022)
  const vaultTokenAccount = getAssociatedTokenAddressSync(
    mint,
    torchVaultPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )

  // Vault's WSOL ATA (SPL Token — persistent, reused across swaps)
  const vaultWsolAccount = getAssociatedTokenAddressSync(
    WSOL_MINT,
    torchVaultPda,
    true,
    TOKEN_PROGRAM_ID,
  )

  // Raydium pool accounts
  const raydium = getRaydiumMigrationAccounts(mint)

  const tx = new Transaction()

  // Create vault token ATA if needed (for first buy of a migrated token)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      signer,
      vaultTokenAccount,
      torchVaultPda,
      mint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // Create vault WSOL ATA if needed (persistent — reused across swaps)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      signer,
      vaultWsolAccount,
      torchVaultPda,
      WSOL_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  const provider = makeDummyProvider(connection, signer)
  const program = new Program(idl as unknown, provider)

  // On buy: fund WSOL with lamports from vault in a separate instruction
  // (isolates direct lamport manipulation from CPIs to avoid runtime balance errors)
  if (is_buy) {
    const fundIx = await program.methods
      .fundVaultWsol(new BN(amount_in.toString()))
      .accounts({
        signer,
        torchVault: torchVaultPda,
        vaultWalletLink: vaultWalletLinkPda,
        vaultWsolAccount,
      } as any)
      .instruction()
    tx.add(fundIx)
  }

  const swapIx = await program.methods
    .vaultSwap(
      new BN(amount_in.toString()),
      new BN(minimum_amount_out.toString()),
      is_buy,
    )
    .accounts({
      signer,
      torchVault: torchVaultPda,
      vaultWalletLink: vaultWalletLinkPda,
      mint,
      bondingCurve: bondingCurvePda,
      vaultTokenAccount,
      vaultWsolAccount,
      raydiumProgram: getRaydiumCpmmProgram(),
      raydiumAuthority: raydium.raydiumAuthority,
      ammConfig: getRaydiumAmmConfig(),
      poolState: raydium.poolState,
      poolTokenVault0: raydium.token0Vault,
      poolTokenVault1: raydium.token1Vault,
      observationState: raydium.observationState,
      wsolMint: WSOL_MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(swapIx)
  await finalizeTransaction(connection, tx, signer)

  const direction = is_buy ? 'Buy' : 'Sell'
  const amountLabel = is_buy
    ? `${amount_in / 1e9} SOL`
    : `${amount_in / 1e6} tokens`

  return {
    transaction: tx,
    message: `${direction} ${amountLabel} via vault DEX swap`,
  }
}

// ============================================================================
// Treasury Cranks
// ============================================================================

// Auto-buyback constants (must match the on-chain program)
const SUPPLY_FLOOR = BigInt('500000000000000') // 500M tokens at 6 decimals
const MIN_BUYBACK_AMOUNT = BigInt('10000000') // 0.01 SOL in lamports
const RATIO_PRECISION = BigInt('1000000000') // 1e9

/**
 * Build an unsigned auto-buyback transaction.
 *
 * Permissionless crank — triggers a treasury buyback on Raydium when the pool
 * price has dropped below the treasury's ratio threshold. Burns bought tokens.
 *
 * Pre-checks all on-chain conditions and throws descriptive errors so the
 * caller (e.g. frontend) knows exactly why a buyback can't fire.
 */
export const buildAutoBuybackTransaction = async (
  connection: Connection,
  params: AutoBuybackParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, payer: payerStr, minimum_amount_out = 1 } = params

  const mint = new PublicKey(mintStr)
  const payer = new PublicKey(payerStr)

  // Fetch on-chain state for pre-checks
  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)
  const { bondingCurve, treasury } = tokenData

  // Pre-check 1: Token must be migrated
  if (!bondingCurve.migrated) {
    throw new Error('Token not yet migrated')
  }

  // Pre-check 2: Baseline must be initialized
  if (!treasury || !treasury.baseline_initialized) {
    throw new Error('Buyback baseline not initialized')
  }

  // Pre-check 3: Cooldown check
  const currentSlot = await connection.getSlot('confirmed')
  const lastBuybackSlot = BigInt(treasury.last_buyback_slot.toString())
  const minInterval = BigInt(treasury.min_buyback_interval_slots.toString())
  const nextBuybackSlot = lastBuybackSlot + minInterval
  if (BigInt(currentSlot) < nextBuybackSlot) {
    const slotsRemaining = Number(nextBuybackSlot - BigInt(currentSlot))
    throw new Error(`Buyback cooldown: ${slotsRemaining} slots remaining`)
  }

  // Pre-check 4: Supply floor
  const mintInfo = await connection.getTokenSupply(mint, 'confirmed')
  const currentSupply = BigInt(mintInfo.value.amount)
  if (currentSupply <= SUPPLY_FLOOR) {
    throw new Error('Supply at floor — buybacks paused')
  }

  // Raydium pool accounts
  const raydium = getRaydiumMigrationAccounts(mint)

  // Pre-check 5: Price check — read pool vault balances
  const solVault = raydium.isWsolToken0 ? raydium.token0Vault : raydium.token1Vault
  const tokenVault = raydium.isWsolToken0 ? raydium.token1Vault : raydium.token0Vault
  const [solVaultInfo, tokenVaultInfo] = await Promise.all([
    connection.getTokenAccountBalance(solVault),
    connection.getTokenAccountBalance(tokenVault),
  ])
  const poolSol = BigInt(solVaultInfo.value.amount)
  const poolTokens = BigInt(tokenVaultInfo.value.amount)

  const baselineSol = BigInt(treasury.baseline_sol_reserves.toString())
  const baselineTokens = BigInt(treasury.baseline_token_reserves.toString())
  const thresholdBps = BigInt(treasury.ratio_threshold_bps)

  if (poolTokens > BigInt(0) && baselineTokens > BigInt(0)) {
    const currentRatio = (poolSol * RATIO_PRECISION) / poolTokens
    const baselineRatio = (baselineSol * RATIO_PRECISION) / baselineTokens
    const thresholdRatio = (baselineRatio * thresholdBps) / BigInt(10000)

    if (currentRatio >= thresholdRatio) {
      const currentPct = Number((currentRatio * BigInt(10000)) / baselineRatio) / 100
      const thresholdPct = Number(thresholdBps) / 100
      throw new Error(
        `Price is healthy — no buyback needed (current: ${currentPct.toFixed(1)}% of baseline, threshold: ${thresholdPct.toFixed(1)}%)`,
      )
    }
  }

  // Pre-check 6: Dust check — compute buyback_amount
  const treasurySolBalance = BigInt(treasury.sol_balance.toString())
  const reserveRatioBps = BigInt(treasury.reserve_ratio_bps)
  const buybackPercentBps = BigInt(treasury.buyback_percent_bps)

  const availableSol = (treasurySolBalance * (BigInt(10000) - reserveRatioBps)) / BigInt(10000)
  const buybackAmount = (availableSol * buybackPercentBps) / BigInt(10000)

  if (buybackAmount < MIN_BUYBACK_AMOUNT) {
    const availableSolNum = Number(availableSol) / 1e9
    throw new Error(
      `Treasury SOL too low for buyback (available: ${availableSolNum.toFixed(4)} SOL, need >= 0.01 SOL after reserves)`,
    )
  }

  // All pre-checks passed — build the transaction
  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const treasuryTokenAccount = getTreasuryTokenAccount(mint, treasuryPda)

  // Treasury's WSOL ATA (SPL Token)
  const treasuryWsol = getAssociatedTokenAddressSync(
    WSOL_MINT,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  )

  // For buyback: input = WSOL (SOL side), output = token
  const inputVault = raydium.isWsolToken0 ? raydium.token0Vault : raydium.token1Vault
  const outputVault = raydium.isWsolToken0 ? raydium.token1Vault : raydium.token0Vault

  const tx = new Transaction()

  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))

  // Create treasury WSOL ATA if needed
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      treasuryWsol,
      treasuryPda,
      WSOL_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  const provider = makeDummyProvider(connection, payer)
  const program = new Program(idl as unknown, provider)

  const buybackIx = await program.methods
    .executeAutoBuyback(new BN(minimum_amount_out.toString()))
    .accounts({
      payer,
      mint,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      treasuryWsol,
      treasuryToken: treasuryTokenAccount,
      raydiumProgram: getRaydiumCpmmProgram(),
      raydiumAuthority: raydium.raydiumAuthority,
      ammConfig: getRaydiumAmmConfig(),
      poolState: raydium.poolState,
      inputVault,
      outputVault,
      wsolMint: WSOL_MINT,
      observationState: raydium.observationState,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(buybackIx)
  await finalizeTransaction(connection, tx, payer)

  const buybackSol = Number(buybackAmount) / 1e9
  return {
    transaction: tx,
    message: `Auto-buyback ${buybackSol.toFixed(4)} SOL for ${mintStr.slice(0, 8)}...`,
  }
}

/**
 * Build an unsigned harvest-fees transaction.
 *
 * Permissionless crank — harvests accumulated Token-2022 transfer fees
 * from token accounts into the mint, then withdraws from the mint into
 * the treasury's token account.
 *
 * If `params.sources` is provided, uses those accounts directly.
 * Otherwise auto-discovers token accounts with withheld fees.
 */
export const buildHarvestFeesTransaction = async (
  connection: Connection,
  params: HarvestFeesParams,
): Promise<TransactionResult> => {
  const { mint: mintStr, payer: payerStr, sources: sourcesStr } = params

  const mint = new PublicKey(mintStr)
  const payer = new PublicKey(payerStr)

  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const treasuryTokenAccount = getTreasuryTokenAccount(mint, treasuryPda)

  // Discover source accounts with withheld transfer fees
  let sourceAccounts: PublicKey[]

  if (sourcesStr && sourcesStr.length > 0) {
    sourceAccounts = sourcesStr.map((s) => new PublicKey(s))
  } else {
    // Auto-discover: fetch largest token accounts and filter to those with withheld > 0
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(mint, 'confirmed')
      const addresses = largestAccounts.value.map((a) => a.address)

      if (addresses.length > 0) {
        const accountInfos = await connection.getMultipleAccountsInfo(addresses)
        sourceAccounts = []

        for (let i = 0; i < addresses.length; i++) {
          const info = accountInfos[i]
          if (!info) continue
          try {
            const account = unpackAccount(addresses[i], info, TOKEN_2022_PROGRAM_ID)
            const feeAmount = getTransferFeeAmount(account)
            if (feeAmount && feeAmount.withheldAmount > BigInt(0)) {
              sourceAccounts.push(addresses[i])
            }
          } catch {
            // Not a Token-2022 account or can't decode — skip
          }
        }
      } else {
        sourceAccounts = []
      }
    } catch {
      // RPC doesn't support getTokenLargestAccounts — proceed without source accounts
      sourceAccounts = []
    }
  }

  const provider = makeDummyProvider(connection, payer)
  const program = new Program(idl as unknown, provider)

  const tx = new Transaction()

  // Scale compute budget: base 200k + 20k per source account (Token-2022 harvest CPI is expensive)
  const computeUnits = 200_000 + 20_000 * sourceAccounts.length
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }))

  const harvestIx = await program.methods
    .harvestFees()
    .accounts({
      payer,
      mint,
      bondingCurve: bondingCurvePda,
      tokenTreasury: treasuryPda,
      treasuryTokenAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    } as any)
    .remainingAccounts(
      sourceAccounts.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    )
    .instruction()

  tx.add(harvestIx)
  await finalizeTransaction(connection, tx, payer)

  return {
    transaction: tx,
    message: `Harvest transfer fees for ${mintStr.slice(0, 8)}... (${sourceAccounts.length} source accounts)`,
  }
}

/**
 * [V20] Harvest transfer fees AND swap them to SOL in a single transaction.
 *
 * Bundles: create_idempotent(treasury_wsol) + harvest_fees + swap_fees_to_sol.
 * Set harvest=false to skip harvest (if already harvested separately).
 */
export const buildSwapFeesToSolTransaction = async (
  connection: Connection,
  params: SwapFeesToSolParams,
): Promise<TransactionResult> => {
  const {
    mint: mintStr,
    payer: payerStr,
    minimum_amount_out = 1,
    harvest = true,
    sources: sourcesStr,
  } = params

  const mint = new PublicKey(mintStr)
  const payer = new PublicKey(payerStr)

  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)
  const treasuryTokenAccount = getTreasuryTokenAccount(mint, treasuryPda)

  // Treasury's WSOL ATA (SPL Token, not Token-2022)
  const treasuryWsol = getAssociatedTokenAddressSync(
    WSOL_MINT,
    treasuryPda,
    true,
    TOKEN_PROGRAM_ID,
  )

  // Raydium accounts — swap direction is token → WSOL (sell)
  const raydium = getRaydiumMigrationAccounts(mint)
  const tokenVault = raydium.isWsolToken0 ? raydium.token1Vault : raydium.token0Vault
  const wsolVault = raydium.isWsolToken0 ? raydium.token0Vault : raydium.token1Vault

  const provider = makeDummyProvider(connection, payer)
  const program = new Program(idl as unknown, provider)

  const tx = new Transaction()

  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))

  // Create treasury WSOL ATA if needed (idempotent)
  tx.add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer,
      treasuryWsol,
      treasuryPda,
      WSOL_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  )

  // Optionally bundle harvest_fees first
  if (harvest) {
    // Auto-discover source accounts with withheld transfer fees
    let sourceAccounts: PublicKey[]

    if (sourcesStr && sourcesStr.length > 0) {
      sourceAccounts = sourcesStr.map((s) => new PublicKey(s))
    } else {
      try {
        const largestAccounts = await connection.getTokenLargestAccounts(mint, 'confirmed')
        const addresses = largestAccounts.value.map((a) => a.address)

        if (addresses.length > 0) {
          const accountInfos = await connection.getMultipleAccountsInfo(addresses)
          sourceAccounts = []

          for (let i = 0; i < addresses.length; i++) {
            const info = accountInfos[i]
            if (!info) continue
            try {
              const account = unpackAccount(addresses[i], info, TOKEN_2022_PROGRAM_ID)
              const feeAmount = getTransferFeeAmount(account)
              if (feeAmount && feeAmount.withheldAmount > BigInt(0)) {
                sourceAccounts.push(addresses[i])
              }
            } catch {
              // Not a Token-2022 account or can't decode — skip
            }
          }
        } else {
          sourceAccounts = []
        }
      } catch {
        sourceAccounts = []
      }
    }

    const harvestIx = await program.methods
      .harvestFees()
      .accounts({
        payer,
        mint,
        bondingCurve: bondingCurvePda,
        tokenTreasury: treasuryPda,
        treasuryTokenAccount,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .remainingAccounts(
        sourceAccounts.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: true,
        })),
      )
      .instruction()

    tx.add(harvestIx)
  }

  // swap_fees_to_sol instruction
  const swapIx = await program.methods
    .swapFeesToSol(new BN(minimum_amount_out.toString()))
    .accounts({
      payer,
      mint,
      bondingCurve: bondingCurvePda,
      treasury: treasuryPda,
      treasuryTokenAccount,
      treasuryWsol,
      raydiumProgram: getRaydiumCpmmProgram(),
      raydiumAuthority: raydium.raydiumAuthority,
      ammConfig: getRaydiumAmmConfig(),
      poolState: raydium.poolState,
      tokenVault,
      wsolVault,
      wsolMint: WSOL_MINT,
      observationState: raydium.observationState,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction()

  tx.add(swapIx)
  await finalizeTransaction(connection, tx, payer)

  return {
    transaction: tx,
    message: `Swap harvested fees to SOL for ${mintStr.slice(0, 8)}...${harvest ? ' (harvest + swap)' : ''}`,
  }
}
