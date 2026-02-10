/**
 * Token data fetching
 *
 * Read-only functions for querying token state from Solana.
 */

import { Connection, PublicKey } from '@solana/web3.js'
import { BorshCoder, Idl } from '@coral-xyz/anchor'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import {
  BondingCurve,
  Treasury,
  TorchVault,
  VaultWalletLink,
  LoanPosition,
  decodeString,
  getBondingCurvePda,
  getTokenTreasuryPda,
  getLoanPositionPda,
  getCollateralVaultPda,
  getTorchVaultPda,
  getVaultWalletLinkPda,
  getRaydiumMigrationAccounts,
  calculateBondingProgress,
  calculatePrice,
} from './program'
import {
  PROGRAM_ID,
  BLACKLISTED_MINTS,
  LAMPORTS_PER_SOL,
  TOKEN_MULTIPLIER,
  TOTAL_SUPPLY,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_DECIMALS,
  MEMO_PROGRAM_ID,
} from './constants'
import { fetchWithFallback, irysToUploader, isIrysUrl } from './gateway'
import idl from './torch_market.json'
import {
  TokenSummary,
  TokenDetail,
  TokenStatus,
  TokenListParams,
  TokenListResult,
  Holder,
  HoldersResult,
  TokenMessage,
  MessagesResult,
  SaidVerification,
  LendingInfo,
  LoanPositionInfo,
  VaultInfo,
  VaultWalletLinkInfo,
} from './types'

// ============================================================================
// Internal helpers
// ============================================================================

interface RawToken {
  mint: string
  bondingCurve: BondingCurve
}

const getTokenStatus = (bc: BondingCurve): TokenStatus => {
  if (bc.migrated) return 'migrated'
  if (bc.bonding_complete) return 'complete'
  return 'bonding'
}

const fetchAllRawTokens = async (connection: Connection): Promise<RawToken[]> => {
  const coder = new BorshCoder(idl as unknown as Idl)

  const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: '4y6pru6YvC7' } }],
  })

  const tokens: RawToken[] = []

  for (const acc of accounts) {
    try {
      const decoded = coder.accounts.decode('BondingCurve', acc.account.data)
      const mintStr = decoded.mint.toString()

      if (BLACKLISTED_MINTS.includes(mintStr)) continue
      if (decoded.reclaimed) continue

      tokens.push({
        mint: mintStr,
        bondingCurve: decoded as unknown as BondingCurve,
      })
    } catch {
      // Not a bonding curve account
    }
  }

  return tokens
}

const toTokenSummary = (raw: RawToken): TokenSummary => {
  const bc = raw.bondingCurve

  const virtualSol = BigInt(bc.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bc.virtual_token_reserves.toString())
  const realSol = BigInt(bc.real_sol_reserves.toString())
  const realTokens = BigInt(bc.real_token_reserves.toString())
  const voteVault = BigInt(bc.vote_vault_balance.toString())

  const price = calculatePrice(virtualSol, virtualTokens)
  const priceInSol = (price * TOKEN_MULTIPLIER) / LAMPORTS_PER_SOL

  const circulating = TOTAL_SUPPLY - realTokens - voteVault
  const marketCapSol = (priceInSol * Number(circulating)) / TOKEN_MULTIPLIER

  return {
    mint: raw.mint,
    name: decodeString(bc.name),
    symbol: decodeString(bc.symbol),
    status: getTokenStatus(bc),
    price_sol: priceInSol,
    market_cap_sol: marketCapSol,
    progress_percent: calculateBondingProgress(realSol),
    holders: null,
    created_at: 0,
  }
}

const filterAndSort = (tokens: RawToken[], params: TokenListParams): RawToken[] => {
  let filtered = [...tokens]

  if (params.status && params.status !== 'all') {
    filtered = filtered.filter((t) => getTokenStatus(t.bondingCurve) === params.status)
  }

  switch (params.sort) {
    case 'marketcap':
    case 'volume':
      filtered.sort((a, b) => {
        const aR = BigInt(a.bondingCurve.real_sol_reserves.toString())
        const bR = BigInt(b.bondingCurve.real_sol_reserves.toString())
        return bR > aR ? 1 : bR < aR ? -1 : 0
      })
      break
    case 'newest':
    default:
      filtered.sort((a, b) => {
        const aA = BigInt(a.bondingCurve.last_activity_slot.toString())
        const bA = BigInt(b.bondingCurve.last_activity_slot.toString())
        return bA > aA ? 1 : bA < aA ? -1 : 0
      })
      break
  }

  const offset = params.offset || 0
  const limit = Math.min(params.limit || 50, 100)
  return filtered.slice(offset, offset + limit)
}

const buildTokenDetail = (
  mint: string,
  bc: BondingCurve,
  treasury: Treasury | null,
  metadata?: {
    description?: string
    image?: string
    twitter?: string
    telegram?: string
    website?: string
  },
  holdersCount?: number | null,
  solPriceUsd?: number,
  saidVerification?: SaidVerification | null,
  warnings?: string[],
): TokenDetail => {
  const virtualSol = BigInt(bc.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bc.virtual_token_reserves.toString())
  const realSol = BigInt(bc.real_sol_reserves.toString())
  const realTokens = BigInt(bc.real_token_reserves.toString())
  const voteVault = BigInt(bc.vote_vault_balance.toString())
  const burned = BigInt(bc.permanently_burned_tokens?.toString() || '0')

  const price = calculatePrice(virtualSol, virtualTokens)
  const priceInSol = (price * TOKEN_MULTIPLIER) / LAMPORTS_PER_SOL
  const circulating = TOTAL_SUPPLY - realTokens - voteVault
  const marketCapSol = (priceInSol * Number(circulating)) / TOKEN_MULTIPLIER

  const treasurySol = treasury ? Number(treasury.sol_balance.toString()) / LAMPORTS_PER_SOL : 0
  const treasuryTokens = treasury ? Number(treasury.tokens_held.toString()) / TOKEN_MULTIPLIER : 0
  const boughtBack = treasury ? Number(treasury.total_bought_back.toString()) / TOKEN_MULTIPLIER : 0
  const buybackCount = treasury ? Number(treasury.buyback_count.toString()) : 0
  const stars = treasury ? Number(treasury.total_stars.toString()) : 0

  return {
    mint,
    name: decodeString(bc.name),
    symbol: decodeString(bc.symbol),
    description: metadata?.description,
    image: metadata?.image,
    status: getTokenStatus(bc),
    price_sol: priceInSol,
    price_usd: solPriceUsd ? priceInSol * solPriceUsd : undefined,
    market_cap_sol: marketCapSol,
    market_cap_usd: solPriceUsd ? marketCapSol * solPriceUsd : undefined,
    progress_percent: calculateBondingProgress(realSol),
    sol_raised: Number(realSol) / LAMPORTS_PER_SOL,
    sol_target: 200,
    total_supply: Number(TOTAL_SUPPLY) / TOKEN_MULTIPLIER,
    circulating_supply: Number(circulating) / TOKEN_MULTIPLIER,
    tokens_in_curve: Number(realTokens) / TOKEN_MULTIPLIER,
    tokens_in_vote_vault: Number(voteVault) / TOKEN_MULTIPLIER,
    tokens_burned: Number(burned) / TOKEN_MULTIPLIER,
    treasury_sol_balance: treasurySol,
    treasury_token_balance: treasuryTokens,
    total_bought_back: boughtBack,
    buyback_count: buybackCount,
    votes_return: Number(bc.votes_return.toString()),
    votes_burn: Number(bc.votes_burn.toString()),
    creator: bc.creator.toString(),
    holders: holdersCount ?? null,
    stars,
    created_at: 0,
    last_activity_at: Number(bc.last_activity_slot.toString()),
    twitter: metadata?.twitter,
    telegram: metadata?.telegram,
    website: metadata?.website,
    creator_verified: saidVerification?.verified,
    creator_trust_tier: saidVerification?.trustTier,
    creator_said_name: saidVerification?.name,
    creator_badge_url: saidVerification?.verified
      ? `https://api.saidprotocol.com/api/badge/${bc.creator.toString()}.svg`
      : undefined,
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  }
}

// Internal: fetch single token on-chain data
const fetchTokenRaw = async (
  connection: Connection,
  mint: PublicKey,
): Promise<{ bondingCurve: BondingCurve; treasury: Treasury | null } | null> => {
  const coder = new BorshCoder(idl as unknown as Idl)

  const [bondingCurvePda] = getBondingCurvePda(mint)
  const [treasuryPda] = getTokenTreasuryPda(mint)

  const [bcAccount, treasuryAccount] = await Promise.all([
    connection.getAccountInfo(bondingCurvePda),
    connection.getAccountInfo(treasuryPda),
  ])

  if (!bcAccount) return null

  const bondingCurve = coder.accounts.decode(
    'BondingCurve',
    bcAccount.data,
  ) as unknown as BondingCurve

  let treasury: Treasury | null = null
  if (treasuryAccount) {
    treasury = coder.accounts.decode('Treasury', treasuryAccount.data) as unknown as Treasury
  }

  return { bondingCurve, treasury }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * List tokens with optional filtering and sorting.
 */
export const getTokens = async (
  connection: Connection,
  params: TokenListParams = {},
): Promise<TokenListResult> => {
  const allTokens = await fetchAllRawTokens(connection)
  const filtered = filterAndSort(allTokens, params)
  const summaries = filtered.map(toTokenSummary)

  return {
    tokens: summaries,
    total: allTokens.length,
    limit: params.limit || 50,
    offset: params.offset || 0,
  }
}

/**
 * Get detailed info for a single token.
 */
export const getToken = async (connection: Connection, mintStr: string): Promise<TokenDetail> => {
  const mint = new PublicKey(mintStr)
  const tokenData = await fetchTokenRaw(connection, mint)

  if (!tokenData) {
    throw new Error(`Token not found: ${mintStr}`)
  }

  const { bondingCurve, treasury } = tokenData
  const warnings: string[] = []

  // Fetch metadata from URI
  let metadata:
    | {
        description?: string
        image?: string
        twitter?: string
        telegram?: string
        website?: string
      }
    | undefined
  const uri = decodeString(bondingCurve.uri)
  if (uri) {
    try {
      const res = await fetchWithFallback(uri)
      const data = (await res.json()) as Record<string, any>
      metadata = {
        description: data.description,
        image: data.image && isIrysUrl(data.image) ? irysToUploader(data.image) : data.image,
        twitter: data.twitter,
        telegram: data.telegram,
        website: data.website,
      }
    } catch (e) {
      warnings.push(`Metadata fetch failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Fetch holders count
  let holdersCount: number | null = null
  try {
    const holders = await connection.getTokenLargestAccounts(mint, 'confirmed')
    holdersCount = holders.value.filter((a) => a.uiAmount && a.uiAmount > 0).length
  } catch (e) {
    warnings.push(`Holders fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Fetch SOL price
  let solPriceUsd: number | undefined
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    )
    const data = (await res.json()) as { solana?: { usd?: number } }
    solPriceUsd = data?.solana?.usd
  } catch (e) {
    warnings.push(`SOL price fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return buildTokenDetail(mintStr, bondingCurve, treasury, metadata, holdersCount, solPriceUsd, undefined, warnings)
}

/**
 * Get top holders for a token.
 */
export const getHolders = async (
  connection: Connection,
  mintStr: string,
  limit: number = 20,
): Promise<HoldersResult> => {
  const mint = new PublicKey(mintStr)
  const safeLimit = Math.min(limit, 100)

  // Build excluded addresses (pools/vaults)
  const excluded = new Set<string>()

  const [bondingCurvePda] = getBondingCurvePda(mint)
  const bondingCurveVault = getAssociatedTokenAddressSync(
    mint,
    bondingCurvePda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  excluded.add(bondingCurveVault.toString())

  const [treasuryPda] = getTokenTreasuryPda(mint)
  const treasuryVault = getAssociatedTokenAddressSync(
    mint,
    treasuryPda,
    true,
    TOKEN_2022_PROGRAM_ID,
  )
  excluded.add(treasuryVault.toString())

  try {
    const raydiumAccounts = getRaydiumMigrationAccounts(mint)
    excluded.add(raydiumAccounts.token0Vault.toString())
    excluded.add(raydiumAccounts.token1Vault.toString())
  } catch {
    // Ignore
  }

  const response = await connection.getTokenLargestAccounts(mint, 'confirmed')
  const totalSupply = BigInt(1_000_000_000) * BigInt(10 ** TOKEN_DECIMALS)

  const filteredAccounts = response.value
    .filter((account) => account.uiAmount && account.uiAmount > 0)
    .filter((account) => !excluded.has(account.address.toString()))
    .slice(0, safeLimit)

  const accountInfos = await connection.getMultipleParsedAccounts(
    filteredAccounts.map((a) => a.address),
  )

  const holders: Holder[] = filteredAccounts.map((account, i) => {
    const parsed = accountInfos.value[i]?.data
    const owner = parsed && 'parsed' in parsed ? (parsed as any).parsed?.info?.owner : null
    return {
      address: owner || account.address.toString(),
      balance: Number(account.amount) / 10 ** TOKEN_DECIMALS,
      percentage: (Number(account.amount) / Number(totalSupply)) * 100,
    }
  })

  return {
    holders,
    total_holders: response.value.filter(
      (a) => a.uiAmount && a.uiAmount > 0 && !excluded.has(a.address.toString()),
    ).length,
  }
}

/**
 * Get messages (memos) for a token.
 */
export const getMessages = async (
  connection: Connection,
  mintStr: string,
  limit: number = 50,
): Promise<MessagesResult> => {
  const mint = new PublicKey(mintStr)
  const safeLimit = Math.min(limit, 100)

  const [bondingCurvePda] = getBondingCurvePda(mint)

  const signatures = await connection.getSignaturesForAddress(
    bondingCurvePda,
    { limit: 500 },
    'confirmed',
  )

  const messages: TokenMessage[] = []

  for (const sig of signatures) {
    if (messages.length >= safeLimit) break

    try {
      const tx = await connection.getParsedTransaction(sig.signature, {
        maxSupportedTransactionVersion: 0,
      })

      if (!tx?.meta || tx.meta.err) continue

      for (const ix of tx.transaction.message.instructions) {
        const programId = 'programId' in ix ? ix.programId.toString() : ''
        const programName = 'program' in ix ? (ix as { program: string }).program : ''

        const isMemo =
          programId === MEMO_PROGRAM_ID.toString() ||
          programId === 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr' ||
          programName === 'spl-memo'

        if (isMemo) {
          let memoText = ''

          if ('parsed' in ix) {
            memoText = typeof ix.parsed === 'string' ? ix.parsed : JSON.stringify(ix.parsed)
          } else if ('data' in ix && typeof ix.data === 'string') {
            try {
              const bs58 = await import('bs58')
              const decoded = bs58.default.decode(ix.data)
              memoText = new TextDecoder().decode(decoded)
            } catch {
              memoText = ix.data
            }
          }

          if (memoText && memoText.trim()) {
            const sender = tx.transaction.message.accountKeys[0]?.pubkey?.toString() || 'Unknown'
            messages.push({
              signature: sig.signature,
              memo: memoText.trim(),
              sender,
              timestamp: sig.blockTime || 0,
            })
            break
          }
        }
      }
    } catch {
      // Skip failed parsing
    }
  }

  return { messages, total: messages.length }
}

// ============================================================================
// Lending (V2.4)
// ============================================================================

// Lending constants (matching the Rust program)
const INTEREST_RATE_BPS = 200 // 2% per epoch
const MAX_LTV_BPS = 5000 // 50%
const LIQUIDATION_THRESHOLD_BPS = 6500 // 65%
const LIQUIDATION_BONUS_BPS = 1000 // 10%

/**
 * Get lending info for a migrated token.
 *
 * Returns interest rates, LTV limits, and active loan statistics.
 * Lending is available on all migrated tokens with treasury SOL.
 */
export const getLendingInfo = async (
  connection: Connection,
  mintStr: string,
): Promise<LendingInfo> => {
  const mint = new PublicKey(mintStr)

  const tokenData = await fetchTokenRaw(connection, mint)
  if (!tokenData) throw new Error(`Token not found: ${mintStr}`)

  const { bondingCurve, treasury } = tokenData
  if (!bondingCurve.migrated) throw new Error('Token not yet migrated, lending not available')

  const treasurySol = treasury ? Number(treasury.sol_balance.toString()) : 0

  // Scan for active loan positions via collateral vault balance
  const [collateralVaultPda] = getCollateralVaultPda(mint)
  const vaultInfo = await connection.getAccountInfo(collateralVaultPda)

  // Count active loans by scanning LoanPosition accounts
  let activeLoans: number | null = 0
  let totalSolLent: number | null = 0
  const warnings: string[] = []

  try {
    const loanDiscriminator = Buffer.from([45, 172, 28, 194, 82, 206, 243, 190])
    const accounts = await connection.getProgramAccounts(PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: loanDiscriminator.toString('base64') } },
        { memcmp: { offset: 8 + 32, bytes: mint.toBase58() } }, // mint at offset 40
      ],
      dataSlice: { offset: 8 + 32 + 32, length: 16 }, // collateral_amount + borrowed_amount
    })

    for (const acc of accounts) {
      try {
        // Read borrowed_amount (u64 at offset 8 within the slice)
        const borrowed = acc.account.data.readBigUInt64LE(8)
        if (borrowed > BigInt(0)) {
          activeLoans = (activeLoans ?? 0) + 1
          totalSolLent = (totalSolLent ?? 0) + Number(borrowed)
        }
      } catch {
        // Skip malformed accounts
      }
    }
  } catch (e) {
    activeLoans = null
    totalSolLent = null
    warnings.push(`Loan enumeration failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  return {
    interest_rate_bps: INTEREST_RATE_BPS,
    max_ltv_bps: MAX_LTV_BPS,
    liquidation_threshold_bps: LIQUIDATION_THRESHOLD_BPS,
    liquidation_bonus_bps: LIQUIDATION_BONUS_BPS,
    total_sol_lent: totalSolLent,
    active_loans: activeLoans,
    treasury_sol_available: treasurySol,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Get loan position for a wallet on a specific token.
 *
 * Returns collateral locked, SOL owed, health status, etc.
 * Returns health="none" if no active loan exists.
 */
export const getLoanPosition = async (
  connection: Connection,
  mintStr: string,
  walletStr: string,
): Promise<LoanPositionInfo> => {
  const mint = new PublicKey(mintStr)
  const wallet = new PublicKey(walletStr)
  const coder = new BorshCoder(idl as unknown as Idl)

  const [loanPositionPda] = getLoanPositionPda(mint, wallet)
  const accountInfo = await connection.getAccountInfo(loanPositionPda)

  if (!accountInfo) {
    return {
      collateral_amount: 0,
      borrowed_amount: 0,
      accrued_interest: 0,
      total_owed: 0,
      collateral_value_sol: 0,
      current_ltv_bps: 0,
      health: 'none',
    }
  }

  const loan = coder.accounts.decode('LoanPosition', accountInfo.data) as unknown as LoanPosition

  const collateral = Number(loan.collateral_amount.toString())
  const borrowed = Number(loan.borrowed_amount.toString())
  const interest = Number(loan.accrued_interest.toString())
  const totalOwed = borrowed + interest

  // Get collateral value from Raydium pool price
  let collateralValueSol: number | null = 0
  const warnings: string[] = []
  try {
    const raydium = getRaydiumMigrationAccounts(mint)
    const [vault0Info, vault1Info] = await Promise.all([
      connection.getTokenAccountBalance(raydium.token0Vault),
      connection.getTokenAccountBalance(raydium.token1Vault),
    ])

    const vault0Amount = Number(vault0Info.value.amount)
    const vault1Amount = Number(vault1Info.value.amount)

    // Determine which vault is SOL and which is token
    if (raydium.isWsolToken0) {
      // token0 = WSOL, token1 = token
      const solReserves = vault0Amount
      const tokenReserves = vault1Amount
      if (tokenReserves > 0) {
        collateralValueSol = (collateral * solReserves) / tokenReserves
      }
    } else {
      // token0 = token, token1 = WSOL
      const solReserves = vault1Amount
      const tokenReserves = vault0Amount
      if (tokenReserves > 0) {
        collateralValueSol = (collateral * solReserves) / tokenReserves
      }
    }
  } catch (e) {
    collateralValueSol = null
    warnings.push(`Collateral valuation failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  let currentLtvBps: number | null
  if (collateralValueSol === null) {
    currentLtvBps = null
  } else if (collateralValueSol > 0) {
    currentLtvBps = Math.floor((totalOwed / collateralValueSol) * 10000)
  } else {
    currentLtvBps = totalOwed > 0 ? 10000 : 0
  }

  let health: LoanPositionInfo['health']
  if (borrowed === 0 && interest === 0) {
    health = 'none'
  } else if (currentLtvBps === null) {
    health = 'healthy'
  } else if (currentLtvBps >= LIQUIDATION_THRESHOLD_BPS) {
    health = 'liquidatable'
  } else if (currentLtvBps >= MAX_LTV_BPS) {
    health = 'at_risk'
  } else {
    health = 'healthy'
  }

  return {
    collateral_amount: collateral,
    borrowed_amount: borrowed,
    accrued_interest: interest,
    total_owed: totalOwed,
    collateral_value_sol: collateralValueSol,
    current_ltv_bps: currentLtvBps,
    health,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// ============================================================================
// Vault Queries (V2.0)
// ============================================================================

/**
 * Get vault state by the vault creator's public key.
 *
 * Returns vault balance, authority, linked wallet count, etc.
 * Returns null if no vault exists for this creator.
 */
export const getVault = async (
  connection: Connection,
  creatorStr: string,
): Promise<VaultInfo | null> => {
  const creator = new PublicKey(creatorStr)
  const coder = new BorshCoder(idl as unknown as Idl)

  const [vaultPda] = getTorchVaultPda(creator)
  const accountInfo = await connection.getAccountInfo(vaultPda)

  if (!accountInfo) return null

  const vault = coder.accounts.decode('TorchVault', accountInfo.data) as unknown as TorchVault

  return {
    address: vaultPda.toString(),
    creator: vault.creator.toString(),
    authority: vault.authority.toString(),
    sol_balance: Number(vault.sol_balance.toString()) / LAMPORTS_PER_SOL,
    total_deposited: Number(vault.total_deposited.toString()) / LAMPORTS_PER_SOL,
    total_withdrawn: Number(vault.total_withdrawn.toString()) / LAMPORTS_PER_SOL,
    total_spent: Number(vault.total_spent.toString()) / LAMPORTS_PER_SOL,
    linked_wallets: vault.linked_wallets,
    created_at: Number(vault.created_at.toString()),
  }
}

/**
 * Get vault state by looking up a linked wallet's VaultWalletLink.
 *
 * Useful when you have an agent wallet and need to find its vault.
 * Returns null if the wallet is not linked to any vault.
 */
export const getVaultForWallet = async (
  connection: Connection,
  walletStr: string,
): Promise<VaultInfo | null> => {
  const wallet = new PublicKey(walletStr)
  const coder = new BorshCoder(idl as unknown as Idl)

  const [walletLinkPda] = getVaultWalletLinkPda(wallet)
  const linkInfo = await connection.getAccountInfo(walletLinkPda)

  if (!linkInfo) return null

  const link = coder.accounts.decode('VaultWalletLink', linkInfo.data) as unknown as VaultWalletLink

  // Now fetch the vault using the vault PDA stored in the link
  const vaultInfo = await connection.getAccountInfo(link.vault)
  if (!vaultInfo) return null

  const vault = coder.accounts.decode('TorchVault', vaultInfo.data) as unknown as TorchVault

  return {
    address: link.vault.toString(),
    creator: vault.creator.toString(),
    authority: vault.authority.toString(),
    sol_balance: Number(vault.sol_balance.toString()) / LAMPORTS_PER_SOL,
    total_deposited: Number(vault.total_deposited.toString()) / LAMPORTS_PER_SOL,
    total_withdrawn: Number(vault.total_withdrawn.toString()) / LAMPORTS_PER_SOL,
    total_spent: Number(vault.total_spent.toString()) / LAMPORTS_PER_SOL,
    linked_wallets: vault.linked_wallets,
    created_at: Number(vault.created_at.toString()),
  }
}

/**
 * Get wallet link state for a specific wallet.
 *
 * Returns the link info (which vault it's linked to, when) or null if not linked.
 */
export const getVaultWalletLink = async (
  connection: Connection,
  walletStr: string,
): Promise<VaultWalletLinkInfo | null> => {
  const wallet = new PublicKey(walletStr)
  const coder = new BorshCoder(idl as unknown as Idl)

  const [walletLinkPda] = getVaultWalletLinkPda(wallet)
  const accountInfo = await connection.getAccountInfo(walletLinkPda)

  if (!accountInfo) return null

  const link = coder.accounts.decode('VaultWalletLink', accountInfo.data) as unknown as VaultWalletLink

  return {
    address: walletLinkPda.toString(),
    vault: link.vault.toString(),
    wallet: link.wallet.toString(),
    linked_at: Number(link.linked_at.toString()),
  }
}

// Re-export for internal use by other SDK modules
export { fetchTokenRaw }
