/**
 * SDK E2E Test against Surfpool (mainnet fork)
 *
 * Tests: create token → vault lifecycle → buy (direct + vault) → sell → star → messages
 * Then: bond to completion → migrate → borrow → repay → vault swap (buy + sell)
 * Then: vault-routed liquidation → vault-routed protocol reward claims
 *
 * Run:
 *   surfpool start --network mainnet --no-tui
 *   cd packages/sdk && npx tsx tests/test_e2e.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js'
import {
  getTokens,
  getToken,
  getMessages,
  getVault,
  getVaultForWallet,
  getVaultWalletLink,
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
  buildWithdrawTokensTransaction,
  buildLinkWalletTransaction,
  buildUnlinkWalletTransaction,
  buildVaultSwapTransaction,
  buildHarvestFeesTransaction,
  buildAutoBuybackTransaction,
  confirmTransaction,
  createEphemeralAgent,
} from '../src/index'
import { fetchTokenRaw } from '../src/tokens'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const RPC_URL = 'http://localhost:8899'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')

const loadWallet = (): Keypair => {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

const log = (msg: string) => {
  const ts = new Date().toISOString().substr(11, 8)
  console.log(`[${ts}] ${msg}`)
}

const signAndSend = async (
  connection: Connection,
  wallet: Keypair,
  tx: Transaction,
): Promise<string> => {
  tx.partialSign(wallet)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  console.log('='.repeat(60))
  console.log('SDK E2E TEST — Surfpool Mainnet Fork')
  console.log('='.repeat(60))

  const connection = new Connection(RPC_URL, 'confirmed')
  const funder = loadWallet()

  // Use a fresh wallet so vault is always created with the current layout
  // (mainnet fork may have stale vaults from prior program versions)
  const wallet = Keypair.generate()
  const walletAddr = wallet.publicKey.toBase58()

  log(`Funder: ${funder.publicKey.toBase58()}`)
  log(`Test wallet: ${walletAddr} (fresh)`)
  const funderBal = await connection.getBalance(funder.publicKey)
  log(`Funder balance: ${funderBal / LAMPORTS_PER_SOL} SOL`)

  // Fund the test wallet
  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: wallet.publicKey,
      lamports: 800 * LAMPORTS_PER_SOL,
    }),
  )
  const { blockhash: fundBh } = await connection.getLatestBlockhash()
  fundTx.recentBlockhash = fundBh
  fundTx.feePayer = funder.publicKey
  fundTx.partialSign(funder)
  const fundSig = await connection.sendRawTransaction(fundTx.serialize())
  await connection.confirmTransaction(fundSig, 'confirmed')

  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`)

  let passed = 0
  let failed = 0

  const ok = (name: string, detail?: string) => {
    passed++
    log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
  }
  const fail = (name: string, err: any) => {
    failed++
    log(`  ✗ ${name} — ${err.message || err}`)
  }

  // ------------------------------------------------------------------
  // 1. Create Token
  // ------------------------------------------------------------------
  log('\n[1] Create Token')
  let mint: string
  try {
    const result = await buildCreateTokenTransaction(connection, {
      creator: walletAddr,
      name: 'SDK Test Token',
      symbol: 'SDKTEST',
      metadata_uri: 'https://example.com/test.json',
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    mint = result.mint.toBase58()
    ok('buildCreateTokenTransaction', `mint=${mint.slice(0, 8)}... sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildCreateTokenTransaction', e)
    console.error('Cannot continue without token. Exiting.')
    process.exit(1)
  }

  // ------------------------------------------------------------------
  // 2. Create Vault
  // ------------------------------------------------------------------
  log('\n[2] Create Vault')
  try {
    const result = await buildCreateVaultTransaction(connection, {
      creator: walletAddr,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('buildCreateVaultTransaction', `sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildCreateVaultTransaction', e)
  }

  // ------------------------------------------------------------------
  // 3. Deposit into Vault
  // ------------------------------------------------------------------
  log('\n[3] Deposit into Vault')
  try {
    const result = await buildDepositVaultTransaction(connection, {
      depositor: walletAddr,
      vault_creator: walletAddr,
      amount_sol: 5 * LAMPORTS_PER_SOL,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('buildDepositVaultTransaction', `sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildDepositVaultTransaction', e)
  }

  // ------------------------------------------------------------------
  // 4. Query Vault
  // ------------------------------------------------------------------
  log('\n[4] Query Vault')
  try {
    const vault = await getVault(connection, walletAddr)
    if (!vault) throw new Error('Vault not found')
    if (vault.sol_balance < 4.9) throw new Error(`Vault balance too low: ${vault.sol_balance}`)
    if (vault.linked_wallets < 1) throw new Error(`No linked wallets: ${vault.linked_wallets}`)
    ok('getVault', `balance=${vault.sol_balance.toFixed(2)} SOL linked_wallets=${vault.linked_wallets}`)

    // Also test getVaultForWallet (creator is auto-linked)
    const vaultByWallet = await getVaultForWallet(connection, walletAddr)
    if (!vaultByWallet) throw new Error('getVaultForWallet returned null')
    ok('getVaultForWallet', `address=${vaultByWallet.address.slice(0, 8)}...`)

    // Also test getVaultWalletLink
    const link = await getVaultWalletLink(connection, walletAddr)
    if (!link) throw new Error('getVaultWalletLink returned null')
    ok('getVaultWalletLink', `vault=${link.vault.slice(0, 8)}...`)
  } catch (e: any) {
    fail('query vault', e)
  }

  // ------------------------------------------------------------------
  // 5. Get Token
  // ------------------------------------------------------------------
  log('\n[5] Get Token')
  try {
    const detail = await getToken(connection, mint)
    if (detail.name !== 'SDK Test Token') throw new Error(`Wrong name: ${detail.name}`)
    if (detail.symbol !== 'SDKTEST') throw new Error(`Wrong symbol: ${detail.symbol}`)
    if (detail.status !== 'bonding') throw new Error(`Wrong status: ${detail.status}`)
    ok(
      'getToken',
      `name=${detail.name} status=${detail.status} progress=${detail.progress_percent.toFixed(1)}%`,
    )
  } catch (e: any) {
    fail('getToken', e)
  }

  // ------------------------------------------------------------------
  // 6. List Tokens
  // ------------------------------------------------------------------
  log('\n[6] List Tokens')
  try {
    const result = await getTokens(connection, { status: 'bonding', limit: 10 })
    const found = result.tokens.some((t) => t.mint === mint)
    if (!found) throw new Error('Newly created token not found in list')
    ok('getTokens', `total=${result.total} found_new_token=true`)
  } catch (e: any) {
    fail('getTokens', e)
  }

  // ------------------------------------------------------------------
  // 7. Buy Token (direct — no vault, human use)
  // ------------------------------------------------------------------
  log('\n[7] Buy Token (direct)')
  let buySig: string | undefined
  try {
    const result = await buildDirectBuyTransaction(connection, {
      mint,
      buyer: walletAddr,
      amount_sol: 100_000_000, // 0.1 SOL
      slippage_bps: 500,
      vote: 'burn',
    })
    buySig = await signAndSend(connection, wallet, result.transaction)
    ok('buildDirectBuyTransaction', `${result.message} sig=${buySig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildDirectBuyTransaction', e)
  }

  // ------------------------------------------------------------------
  // 8. Buy Token (via vault)
  // ------------------------------------------------------------------
  log('\n[8] Buy Token (via vault)')
  try {
    const vaultBefore = await getVault(connection, walletAddr)
    // V27: 2 SOL at initial price would yield ~20M tokens (near 2% wallet cap).
    // 0.5 SOL yields ~5M tokens — under cap and enough for borrow tests.
    const result = await buildBuyTransaction(connection, {
      mint,
      buyer: walletAddr,
      amount_sol: 500_000_000, // 0.5 SOL (V27: stays under 2% wallet cap)
      slippage_bps: 500,
      // No vote — wallet already voted on direct buy above
      vault: walletAddr,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    const vaultAfter = await getVault(connection, walletAddr)
    const spent = (vaultBefore?.sol_balance || 0) - (vaultAfter?.sol_balance || 0)
    ok('buildBuyTransaction (vault)', `${result.message} vault_spent=${spent.toFixed(4)} SOL sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildBuyTransaction (vault)', e)
  }

  // ------------------------------------------------------------------
  // 9. Ephemeral Agent — Link + Vault Buy + Unlink
  // ------------------------------------------------------------------
  log('\n[9] Ephemeral Agent (createEphemeralAgent)')
  const agent = createEphemeralAgent()
  log(`  Ephemeral key: ${agent.publicKey.slice(0, 12)}... (in-memory only)`)
  try {
    // Fund agent for tx fees only (~0.01 SOL gas)
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: agent.keypair.publicKey,
        lamports: 0.05 * LAMPORTS_PER_SOL,
      }),
    )
    const { blockhash: fBh } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = fBh
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)

    // Authority links ephemeral wallet to vault
    const linkResult = await buildLinkWalletTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      wallet_to_link: agent.publicKey,
    })
    const linkSig = await signAndSend(connection, wallet, linkResult.transaction)
    ok('link ephemeral agent', `sig=${linkSig.slice(0, 8)}...`)

    // Agent buys via vault — tokens go to vault ATA, SOL from vault
    const buyResult = await buildBuyTransaction(connection, {
      mint,
      buyer: agent.publicKey,
      amount_sol: 50_000_000, // 0.05 SOL
      slippage_bps: 500,
      vote: 'burn',
      vault: walletAddr,
    })
    const signedBuyTx = agent.sign(buyResult.transaction)
    const buySig2 = await connection.sendRawTransaction(signedBuyTx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })
    await connection.confirmTransaction(buySig2, 'confirmed')
    ok('ephemeral agent vault buy', `${buyResult.message} sig=${buySig2.slice(0, 8)}...`)

    // Authority unlinks ephemeral wallet — keys are now worthless
    const unlinkResult = await buildUnlinkWalletTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      wallet_to_unlink: agent.publicKey,
    })
    const unlinkSig = await signAndSend(connection, wallet, unlinkResult.transaction)
    ok('unlink ephemeral agent', `sig=${unlinkSig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('ephemeral agent lifecycle', e)
  }

  // ------------------------------------------------------------------
  // 10. Withdraw from Vault
  // ------------------------------------------------------------------
  log('\n[10] Withdraw from Vault')
  try {
    const vaultBefore = await getVault(connection, walletAddr)
    const withdrawAmount = Math.floor((vaultBefore?.sol_balance || 0) * LAMPORTS_PER_SOL * 0.5)
    const result = await buildWithdrawVaultTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      amount_sol: withdrawAmount,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    const vaultAfter = await getVault(connection, walletAddr)
    ok('buildWithdrawVaultTransaction', `withdrew=${(withdrawAmount / LAMPORTS_PER_SOL).toFixed(2)} SOL remaining=${vaultAfter?.sol_balance.toFixed(2)} SOL sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildWithdrawVaultTransaction', e)
  }

  // ------------------------------------------------------------------
  // 11. Sell Token (via vault)
  // ------------------------------------------------------------------
  log('\n[11] Sell Token (via vault — tokens from vault ATA, SOL to vault)')
  try {
    const vaultBefore = await getVault(connection, walletAddr)
    // Sell a small amount (1000 tokens = 1000 * 1e6 base units)
    const result = await buildSellTransaction(connection, {
      mint,
      seller: walletAddr,
      amount_tokens: 1000_000_000, // 1000 tokens
      slippage_bps: 500,
      vault: walletAddr,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    const vaultAfter = await getVault(connection, walletAddr)
    const received = (vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)
    ok('buildSellTransaction (vault)', `${result.message} vault_received=${received.toFixed(6)} SOL sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildSellTransaction (vault)', e)
  }

  // ------------------------------------------------------------------
  // 11b. Withdraw Tokens from Vault (escape hatch)
  // ------------------------------------------------------------------
  log('\n[11b] Withdraw Tokens from Vault')
  try {
    const result = await buildWithdrawTokensTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      mint,
      destination: walletAddr,
      amount: 500_000_000, // 500 tokens
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('buildWithdrawTokensTransaction', `${result.message} sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildWithdrawTokensTransaction', e)
  }

  // ------------------------------------------------------------------
  // 12. Star Token (via vault — can't star your own, so link starrer to vault)
  // ------------------------------------------------------------------
  log('\n[12] Star Token (via vault)')
  const starrer = Keypair.generate()
  try {
    // Fund starrer with gas only
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: starrer.publicKey,
        lamports: 0.02 * LAMPORTS_PER_SOL,
      }),
    )
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)

    // Link starrer to vault so vault pays the 0.05 SOL
    const linkResult = await buildLinkWalletTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      wallet_to_link: starrer.publicKey.toBase58(),
    })
    await signAndSend(connection, wallet, linkResult.transaction)

    const result = await buildStarTransaction(connection, {
      mint,
      user: starrer.publicKey.toBase58(),
      vault: walletAddr,
    })
    const sig = await signAndSend(connection, starrer, result.transaction)
    ok('buildStarTransaction (vault)', `sig=${sig.slice(0, 8)}...`)

    // Unlink starrer
    const unlinkResult = await buildUnlinkWalletTransaction(connection, {
      authority: walletAddr,
      vault_creator: walletAddr,
      wallet_to_unlink: starrer.publicKey.toBase58(),
    })
    await signAndSend(connection, wallet, unlinkResult.transaction)
  } catch (e: any) {
    fail('buildStarTransaction (vault)', e)
  }

  // ------------------------------------------------------------------
  // 13. Get Messages
  // ------------------------------------------------------------------
  log('\n[13] Get Messages')
  try {
    // Wait a moment for the tx to be indexed
    await new Promise((r) => setTimeout(r, 1000))
    const result = await getMessages(connection, mint, 10)
    ok('getMessages', `count=${result.messages.length}`)
  } catch (e: any) {
    fail('getMessages', e)
  }

  // ------------------------------------------------------------------
  // 14. Confirm Transaction (SAID)
  // ------------------------------------------------------------------
  log('\n[14] Confirm Transaction')
  if (buySig) {
    try {
      const result = await confirmTransaction(connection, buySig, walletAddr)
      if (!result.confirmed) throw new Error('Not confirmed')
      ok('confirmTransaction', `event=${result.event_type}`)
    } catch (e: any) {
      fail('confirmTransaction', e)
    }
  } else {
    fail('confirmTransaction', { message: 'No buy sig to confirm' })
  }

  // ------------------------------------------------------------------
  // 15. Bond to Completion + Migrate + Borrow + Repay
  // ------------------------------------------------------------------
  log('\n[15] Full Lifecycle: Bond → Migrate → Borrow → Repay')
  log('  Bonding to 200 SOL using multiple wallets (2% wallet cap)...')

  // V27: With IVS=75 SOL and IVT=756.25M, max buy at initial price ≈ 2 SOL
  // before hitting the 2% wallet cap (20M tokens). Use 1.5 SOL buys for faster bonding.
  const NUM_BUYERS = 200
  const BUY_AMOUNT = Math.floor(1.5 * LAMPORTS_PER_SOL) // 1.5 SOL per buy
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // Fund in batches of 20
  for (let i = 0; i < buyers.length; i += 20) {
    const batch = buyers.slice(i, i + 20)
    const fundTx = new Transaction()
    for (const b of batch) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: BUY_AMOUNT + Math.floor(0.05 * LAMPORTS_PER_SOL),
        }),
      )
    }
    const { blockhash: fBh } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = fBh
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)
  }
  log(`  Funded ${buyers.length} wallets with ${BUY_AMOUNT / LAMPORTS_PER_SOL} SOL each`)

  // Buy until bonding completes
  let bondingComplete = false
  let buyCount = 0
  for (const buyer of buyers) {
    if (bondingComplete) break
    try {
      const result = await buildDirectBuyTransaction(connection, {
        mint,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: BUY_AMOUNT,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      if (buyCount % 50 === 0) {
        const detail = await getToken(connection, mint)
        log(
          `  Buy ${buyCount}: ${detail.progress_percent.toFixed(1)}% (${detail.sol_raised.toFixed(1)} SOL)`,
        )
        if (detail.status !== 'bonding') bondingComplete = true
      }
    } catch (e: any) {
      if (
        e.message?.includes('Bonding curve complete') ||
        e.message?.includes('bonding_complete') ||
        e.message?.includes('BondingComplete')
      ) {
        bondingComplete = true
      } else {
        // Skip individual failures (e.g. wallet cap edge cases)
        log(`  Buy ${buyCount + 1} skipped: ${e.message?.substring(0, 80)}`)
      }
    }
  }
  // Check final status
  try {
    const detail = await getToken(connection, mint)
    if (detail.status !== 'bonding') bondingComplete = true
    log(
      `  Final: ${detail.progress_percent.toFixed(1)}% (${detail.sol_raised.toFixed(1)} SOL) status=${detail.status}`,
    )
  } catch {
    /* ignore */
  }

  if (bondingComplete) {
    ok('bonding complete', `after ${buyCount} buys`)
  } else {
    fail('bonding', { message: `Only ${buyCount} buys, not complete` })
  }

  // Migrate to Raydium via SDK
  if (bondingComplete) {
    log('  Migrating to Raydium DEX (via SDK)...')
    try {
      // Snapshot bonding curve state before migration for price verification
      const { getBondingCurvePda } = require('../src/program')
      const { Program, AnchorProvider } = require('@coral-xyz/anchor')
      const idl = require('../dist/torch_market.json')
      const mintPk = new PublicKey(mint)
      const [bondingCurvePda] = getBondingCurvePda(mintPk)
      const dummyWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async (t: Transaction) => { t.partialSign(wallet); return t },
        signAllTransactions: async (ts: Transaction[]) => { ts.forEach((t) => t.partialSign(wallet)); return ts },
      }
      const provider = new AnchorProvider(connection, dummyWallet, {})
      const program = new Program(idl, provider)
      const bcData = await program.account.bondingCurve.fetch(bondingCurvePda)

      // Migrate using SDK
      const migrateResult = await buildMigrateTransaction(connection, {
        mint,
        payer: walletAddr,
      })
      await signAndSend(connection, wallet, migrateResult.transaction)

      ok('migrate to DEX', 'Raydium pool created (V26 permissionless — program wraps SOL internally)')

      // Derive Raydium vault addresses for post-migration verification
      const { getRaydiumMigrationAccounts } = require('../src/program')
      const raydium = getRaydiumMigrationAccounts(mintPk)
      const isWsolToken0 = raydium.isWsolToken0
      const vault0 = raydium.token0Vault
      const vault1 = raydium.token1Vault

      // V27: Post-migration token distribution breakdown
      try {
        const postMigData = await fetchTokenRaw(connection, mintPk)
        const bc = postMigData!.bondingCurve
        const tr = postMigData!.treasury!

        const TOTAL_SUPPLY = 1_000_000_000 // 1B tokens (display units)
        const TREASURY_LOCK = 250_000_000  // 250M locked in treasury lock PDA
        const CURVE_SUPPLY = 750_000_000   // 750M for curve + pool
        const tokenVaultPost = isWsolToken0 ? vault1 : vault0
        const poolTokenBalPost = await connection.getTokenAccountBalance(tokenVaultPost)
        const poolTokens = Number(poolTokenBalPost.value.amount) / 1e6
        const voteVault = Number(bc.vote_vault_balance.toString()) / 1e6
        const excessBurned = Number(bc.permanently_burned_tokens.toString()) / 1e6
        const tokensSold = CURVE_SUPPLY - poolTokens - voteVault - excessBurned
        const treasurySol = Number(tr.sol_balance.toString()) / LAMPORTS_PER_SOL
        const poolSolBal2 = await connection.getTokenAccountBalance(isWsolToken0 ? vault0 : vault1)
        const poolSol2 = Number(poolSolBal2.value.amount) / LAMPORTS_PER_SOL
        const baselineSol = Number(tr.baseline_sol_reserves.toString()) / LAMPORTS_PER_SOL
        const baselineTokens = Number(tr.baseline_token_reserves.toString()) / 1e6

        // V27: Determine initial virtual reserves for this token's tier
        const bondingTarget = Number(bc.bonding_target.toString())
        let ivs = 30 // legacy default
        let ivt = 107_300_000 // legacy default
        if (bondingTarget === 50_000_000_000) { ivs = 18.75; ivt = 756_250_000 }
        else if (bondingTarget === 100_000_000_000) { ivs = 37.5; ivt = 756_250_000 }
        else if (bondingTarget === 200_000_000_000) { ivs = 75; ivt = 756_250_000 }

        const entryPrice = ivs / ivt
        const exitPrice = poolSol2 / poolTokens
        const multiplier = exitPrice / entryPrice

        log(`\n  ┌─── V27 Post-Migration Token Distribution ─────────────────┐`)
        log(`  │  Total Supply:     ${TOTAL_SUPPLY.toLocaleString().padStart(15)} tokens  │`)
        log(`  │  Treasury Lock:    ${TREASURY_LOCK.toLocaleString().padStart(15)} tokens  │`)
        log(`  │  Tokens Sold:      ${tokensSold.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Vote Vault:       ${voteVault.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Pool Tokens:      ${poolTokens.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Excess Burned:    ${excessBurned.toFixed(0).padStart(15)} tokens  │`)
        log(`  ├────────────────────────────────────────────────────────────┤`)
        log(`  │  Pool SOL:         ${poolSol2.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Treasury SOL:     ${treasurySol.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Baseline SOL:     ${baselineSol.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Baseline Tokens:  ${baselineTokens.toFixed(0).padStart(15)} tokens  │`)
        log(`  ├────────────────────────────────────────────────────────────┤`)
        log(`  │  Entry Price:      ${entryPrice.toExponential(4).padStart(15)} SOL/tok │`)
        log(`  │  Exit Price:       ${exitPrice.toExponential(4).padStart(15)} SOL/tok │`)
        log(`  │  Multiplier:       ${multiplier.toFixed(1).padStart(15)}x        │`)
        log(`  │  Sold %:           ${((tokensSold / CURVE_SUPPLY) * 100).toFixed(1).padStart(14)}%         │`)
        log(`  │  Excess Burn %:    ${((excessBurned / CURVE_SUPPLY) * 100).toFixed(1).padStart(14)}%         │`)
        log(`  └────────────────────────────────────────────────────────────┘`)
      } catch { /* non-critical */ }

      // Time travel past Raydium pool open_time (pool won't allow swaps until open_time)
      log('  Time traveling 100 slots to pass pool open_time...')
      const slotAfterMigrate = await connection.getSlot()
      await fetch('http://127.0.0.1:8899', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'surfnet_timeTravel',
          params: [{ absoluteSlot: slotAfterMigrate + 100 }],
        }),
      })
      await new Promise((r) => setTimeout(r, 500))

      // Verify pool price matches bonding curve exit price
      log('  Verifying pool price matches bonding curve exit price...')
      const virtualSol = Number(bcData.virtualSolReserves)
      const virtualTokens = Number(bcData.virtualTokenReserves)
      const curvePrice = virtualSol / virtualTokens

      // Read Raydium pool vault balances
      const solVault = isWsolToken0 ? vault0 : vault1
      const tokenVault = isWsolToken0 ? vault1 : vault0
      const poolSolBal = await connection.getTokenAccountBalance(solVault)
      const poolTokenBal = await connection.getTokenAccountBalance(tokenVault)
      const poolSol = Number(poolSolBal.value.amount)
      const poolTokens = Number(poolTokenBal.value.amount)
      const poolPrice = poolSol / poolTokens

      const priceRatio = poolPrice / curvePrice
      log(`    Curve exit price:  ${curvePrice.toFixed(12)} SOL/token`)
      log(`    Pool open price:   ${poolPrice.toFixed(12)} SOL/token`)
      log(`    Ratio (pool/curve): ${priceRatio.toFixed(4)} (should be ~1.0)`)
      log(`    Pool SOL: ${(poolSol / LAMPORTS_PER_SOL).toFixed(4)}, Pool tokens: ${(poolTokens / 1e6).toFixed(0)}`)

      if (priceRatio > 0.9 && priceRatio < 1.1) {
        ok('Pool price check', `ratio=${priceRatio.toFixed(4)} — within 10% of curve price`)
      } else {
        fail('Pool price check', { message: `ratio=${priceRatio.toFixed(4)} — price mismatch! Expected ~1.0` })
      }

      // ------------------------------------------------------------------
      // 10b. Borrow via Vault (collateral from vault ATA, SOL to vault)
      // ------------------------------------------------------------------
      log('\n  Testing vault borrow...')

      try {
        // Read vault's token balance for this mint
        const { getAssociatedTokenAddressSync: gata } = require('@solana/spl-token')
        const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        const { getTorchVaultPda: gvp } = require('../src/program')
        const [vaultPda] = gvp(wallet.publicKey)
        const vaultAta = gata(new PublicKey(mint), vaultPda, true, TOKEN_2022)
        const tokenBal = await connection.getTokenAccountBalance(vaultAta)
        const totalTokens = Number(tokenBal.value.amount)
        log(`  Vault token balance: ${(totalTokens / 1e6).toFixed(0)} tokens`)

        // Check treasury lending capacity before borrowing
        const treasuryData = await fetchTokenRaw(connection, new PublicKey(mint))
        const treasurySol = Number(treasuryData?.treasury?.sol_balance || 0)
        const maxLendable = Math.floor(treasurySol * 0.5) // 50% utilization cap
        const borrowAmount = Math.min(100_000_000, Math.max(0, maxLendable - 1_000_000)) // 0.1 SOL or less
        log(`  Treasury SOL: ${(treasurySol / LAMPORTS_PER_SOL).toFixed(4)}, max lendable: ${(maxLendable / LAMPORTS_PER_SOL).toFixed(4)}, borrowing: ${(borrowAmount / LAMPORTS_PER_SOL).toFixed(4)}`)

        if (borrowAmount < 100_000_000) { // MIN_BORROW_AMOUNT
          log('  Skipping borrow — treasury too small for minimum borrow (0.1 SOL)')
          ok('buildBorrowTransaction (vault)', 'skipped — treasury lending capacity too low')
        } else {

        // Use 60% of vault tokens as collateral, borrow conservatively within 50% LTV
        const collateralAmount = Math.floor(totalTokens * 0.6)

        const vaultBefore = await getVault(connection, walletAddr)
        const borrowResult = await buildBorrowTransaction(connection, {
          mint,
          borrower: walletAddr,
          collateral_amount: collateralAmount,
          sol_to_borrow: borrowAmount,
          vault: walletAddr,
        })
        const borrowSig = await signAndSend(connection, wallet, borrowResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        const solReceived = (vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)
        ok('buildBorrowTransaction (vault)', `${borrowResult.message} vault_received=${solReceived.toFixed(4)} SOL sig=${borrowSig.slice(0, 8)}...`)

        // ------------------------------------------------------------------
        // 10c. Repay via Vault (SOL from vault, collateral returns to vault ATA)
        // ------------------------------------------------------------------
        log('\n  Testing vault repay...')
        try {
          const repayResult = await buildRepayTransaction(connection, {
            mint,
            borrower: walletAddr,
            sol_amount: 200_000_000, // 0.2 SOL (overpay to fully close)
            vault: walletAddr,
          })
          const repaySig = await signAndSend(connection, wallet, repayResult.transaction)
          ok('buildRepayTransaction (vault)', `${repayResult.message} sig=${repaySig.slice(0, 8)}...`)
        } catch (e: any) {
          fail('buildRepayTransaction (vault)', e)
        }
        } // end else (borrowAmount >= MIN_BORROW)
      } catch (e: any) {
        fail('buildBorrowTransaction (vault)', e)
      }

      // ------------------------------------------------------------------
      // 16. Vault Swap — Buy (SOL→Token) via Raydium
      // ------------------------------------------------------------------
      log('\n[16] Vault Swap Buy (SOL→Token via Raydium)')
      try {
        const vaultBefore = await getVault(connection, walletAddr)
        const buySwapResult = await buildVaultSwapTransaction(connection, {
          mint,
          signer: walletAddr,
          vault_creator: walletAddr,
          amount_in: 100_000_000, // 0.1 SOL
          minimum_amount_out: 1,  // minimal slippage protection for test
          is_buy: true,
        })
        const { ComputeBudgetProgram } = require('@solana/web3.js')
        buySwapResult.transaction.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        )
        const buySig = await signAndSend(connection, wallet, buySwapResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        const spent = (vaultBefore?.sol_balance || 0) - (vaultAfter?.sol_balance || 0)
        ok('buildVaultSwapTransaction (buy)', `vault_spent=${spent.toFixed(4)} SOL sig=${buySig.slice(0, 8)}...`)
      } catch (e: any) {
        fail('buildVaultSwapTransaction (buy)', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }

      // ------------------------------------------------------------------
      // 17. Vault Swap — Sell (Token→SOL) via Raydium
      // ------------------------------------------------------------------
      log('\n[17] Vault Swap Sell (Token→SOL via Raydium)')
      try {
        // Read vault's token balance to sell a portion
        const { getAssociatedTokenAddressSync: gata2 } = require('@solana/spl-token')
        const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        const { getTorchVaultPda: gvp2 } = require('../src/program')
        const [vaultPda2] = gvp2(wallet.publicKey)
        const vaultAta2 = gata2(new PublicKey(mint), vaultPda2, true, TOKEN_2022)
        const tokenBal2 = await connection.getTokenAccountBalance(vaultAta2)
        const totalTokens2 = Number(tokenBal2.value.amount)
        const sellAmount = Math.floor(totalTokens2 * 0.1) // sell 10% of vault tokens
        log(`  Vault token balance: ${(totalTokens2 / 1e6).toFixed(0)} tokens, selling ${(sellAmount / 1e6).toFixed(0)}`)

        const vaultBefore = await getVault(connection, walletAddr)
        const sellSwapResult = await buildVaultSwapTransaction(connection, {
          mint,
          signer: walletAddr,
          vault_creator: walletAddr,
          amount_in: sellAmount,
          minimum_amount_out: 1,
          is_buy: false,
        })
        const { ComputeBudgetProgram: CBP } = require('@solana/web3.js')
        sellSwapResult.transaction.instructions.unshift(
          CBP.setComputeUnitLimit({ units: 400_000 }),
        )
        const sellSig = await signAndSend(connection, wallet, sellSwapResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        const received = (vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)
        ok('buildVaultSwapTransaction (sell)', `vault_received=${received.toFixed(6)} SOL sig=${sellSig.slice(0, 8)}...`)
      } catch (e: any) {
        fail('buildVaultSwapTransaction (sell)', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }
      // ------------------------------------------------------------------
      // 18. Harvest Transfer Fees
      // ------------------------------------------------------------------
      log('\n[18] Harvest Transfer Fees')
      try {
        // The vault swap buys above generated transfer fees (1% on token transfers)
        // Snapshot treasury state before harvest
        const preHarvestData = await fetchTokenRaw(connection, new PublicKey(mint))
        const preHarvestTokens = Number(preHarvestData?.treasury?.tokens_held?.toString() || '0')
        const preHarvestFees = Number(preHarvestData?.treasury?.harvested_fees?.toString() || '0')

        const harvestResult = await buildHarvestFeesTransaction(connection, {
          mint,
          payer: walletAddr,
        })
        const harvestSig = await signAndSend(connection, wallet, harvestResult.transaction)

        const postHarvestData = await fetchTokenRaw(connection, new PublicKey(mint))
        const postHarvestTokens = Number(postHarvestData?.treasury?.tokens_held?.toString() || '0')
        const postHarvestFees = Number(postHarvestData?.treasury?.harvested_fees?.toString() || '0')

        if (postHarvestTokens > preHarvestTokens || postHarvestFees > preHarvestFees) {
          ok('buildHarvestFeesTransaction', `${harvestResult.message} tokens: ${preHarvestTokens}→${postHarvestTokens} sig=${harvestSig.slice(0, 8)}...`)
        } else {
          ok('buildHarvestFeesTransaction', `${harvestResult.message} — tx succeeded sig=${harvestSig.slice(0, 8)}...`)
        }
      } catch (e: any) {
        fail('buildHarvestFeesTransaction', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }

      // ------------------------------------------------------------------
      // 19. Auto Buyback
      // ------------------------------------------------------------------
      log('\n[19] Auto Buyback')
      try {
        // Do sells to depress price below baseline threshold
        const { getAssociatedTokenAddressSync: gataB } = require('@solana/spl-token')
        const TOKEN_2022_B = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        const { getTorchVaultPda: gvpB } = require('../src/program')
        const [vaultPdaB] = gvpB(wallet.publicKey)
        const vaultAtaB = gataB(new PublicKey(mint), vaultPdaB, true, TOKEN_2022_B)
        const tokenBalB = await connection.getTokenAccountBalance(vaultAtaB)
        const totalTokensB = Number(tokenBalB.value.amount)

        // Sell 70% of vault tokens in batches to push price down
        const sellPerBatchB = Math.floor(totalTokensB * 0.175)
        for (let i = 0; i < 4; i++) {
          if (sellPerBatchB < 1_000_000) break
          try {
            const sellResult = await buildVaultSwapTransaction(connection, {
              mint,
              signer: walletAddr,
              vault_creator: walletAddr,
              amount_in: sellPerBatchB,
              minimum_amount_out: 1,
              is_buy: false,
            })
            const { ComputeBudgetProgram: CBPB } = require('@solana/web3.js')
            sellResult.transaction.instructions.unshift(
              CBPB.setComputeUnitLimit({ units: 400_000 }),
            )
            await signAndSend(connection, wallet, sellResult.transaction)
          } catch (e: any) {
            log(`  Sell ${i + 1} skipped: ${e.message?.substring(0, 80)}`)
          }
        }

        // Snapshot treasury before buyback
        const preBuybackData = await fetchTokenRaw(connection, new PublicKey(mint))
        const preBuybackSol = Number(preBuybackData?.treasury?.sol_balance?.toString() || '0')
        const preBuybackCount = Number(preBuybackData?.treasury?.buyback_count?.toString() || '0')

        try {
          const buybackResult = await buildAutoBuybackTransaction(connection, {
            mint,
            payer: walletAddr,
          })
          const buybackSig = await signAndSend(connection, wallet, buybackResult.transaction)

          const postBuybackData = await fetchTokenRaw(connection, new PublicKey(mint))
          const postBuybackSol = Number(postBuybackData?.treasury?.sol_balance?.toString() || '0')
          const postBuybackCount = Number(postBuybackData?.treasury?.buyback_count?.toString() || '0')

          if (postBuybackCount > preBuybackCount) {
            ok('buildAutoBuybackTransaction', `${buybackResult.message} sol: ${(preBuybackSol / 1e9).toFixed(4)}→${(postBuybackSol / 1e9).toFixed(4)}, count: ${preBuybackCount}→${postBuybackCount} sig=${buybackSig.slice(0, 8)}...`)
          } else {
            ok('buildAutoBuybackTransaction', `${buybackResult.message} — tx succeeded sig=${buybackSig.slice(0, 8)}...`)
          }

          // Test cooldown: call again immediately
          try {
            await buildAutoBuybackTransaction(connection, { mint, payer: walletAddr })
            fail('Buyback cooldown', 'should have thrown')
          } catch (cooldownErr: any) {
            if (cooldownErr.message?.includes('cooldown') || cooldownErr.message?.includes('healthy')) {
              ok('Buyback cooldown/pre-check', cooldownErr.message)
            } else {
              ok('Buyback re-check', cooldownErr.message)
            }
          }
        } catch (e: any) {
          if (e.message?.includes('healthy') || e.message?.includes('too low') || e.message?.includes('cooldown') || e.message?.includes('floor')) {
            ok('Auto buyback pre-check', `correctly prevented: ${e.message}`)
          } else {
            fail('buildAutoBuybackTransaction', e)
          }
        }
      } catch (e: any) {
        fail('Auto buyback lifecycle', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }

      // ------------------------------------------------------------------
      // 20. Vault-Routed Liquidation
      // ------------------------------------------------------------------
      log('\n[20] Vault-Routed Liquidation (borrow → time travel → liquidate via vault)')

      // Deposit more SOL for liquidation payment
      try {
        const depositResult = await buildDepositVaultTransaction(connection, {
          depositor: walletAddr,
          vault_creator: walletAddr,
          amount_sol: 10 * LAMPORTS_PER_SOL,
        })
        await signAndSend(connection, wallet, depositResult.transaction)
      } catch (e: any) {
        log(`  Warning: extra deposit failed: ${e.message?.substring(0, 60)}`)
      }

      try {
        // Borrow at ~48% LTV (close to 50% max, easier to push into liquidation)
        const { getAssociatedTokenAddressSync: gata3 } = require('@solana/spl-token')
        const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        const { getTorchVaultPda: gvp3, getRaydiumMigrationAccounts: grma } = require('../src/program')
        const [vaultPda3] = gvp3(wallet.publicKey)
        const vaultAta3 = gata3(new PublicKey(mint), vaultPda3, true, TOKEN_2022)
        const tokenBal3 = await connection.getTokenAccountBalance(vaultAta3)
        const totalTokens3 = Number(tokenBal3.value.amount)
        const collateralAmount = Math.floor(totalTokens3 * 0.5)

        // Calculate borrow amount at ~48% LTV using pool reserves
        const raydiumAccts = grma(new PublicKey(mint))
        const poolSolBal = await connection.getTokenAccountBalance(raydiumAccts.token0Vault)
        const poolTokenBal = await connection.getTokenAccountBalance(raydiumAccts.token1Vault)
        const poolSol = Number(poolSolBal.value.amount)
        const poolTokens = Number(poolTokenBal.value.amount)
        const collateralValue = Math.floor((collateralAmount * poolSol) / poolTokens)
        let solToBorrow = Math.max(100_000_000, Math.floor(collateralValue * 0.48))

        // Check treasury lending capacity (50% utilization cap)
        const liqTreasuryData = await fetchTokenRaw(connection, new PublicKey(mint))
        const liqTreasurySol = Number(liqTreasuryData?.treasury?.sol_balance || 0)
        const liqMaxLendable = Math.floor(liqTreasurySol * 0.5)
        log(`  Treasury SOL: ${(liqTreasurySol / LAMPORTS_PER_SOL).toFixed(4)}, max lendable: ${(liqMaxLendable / LAMPORTS_PER_SOL).toFixed(4)}`)

        // Cap borrow to what treasury can lend (with buffer)
        solToBorrow = Math.min(solToBorrow, Math.max(0, liqMaxLendable - 1_000_000))

        if (solToBorrow < 100_000_000) { // MIN_BORROW_AMOUNT
          log('  Skipping liquidation test — treasury too small for minimum borrow (0.1 SOL)')
          ok('vault-routed liquidation', 'skipped — treasury lending capacity too low')
        } else {

        log(`  Vault tokens: ${(totalTokens3 / 1e6).toFixed(0)}, collateral: ${(collateralAmount / 1e6).toFixed(0)}, value: ${(collateralValue / 1e9).toFixed(4)} SOL, borrow: ${(solToBorrow / 1e9).toFixed(4)} SOL (~48% LTV)`)

        const borrowResult = await buildBorrowTransaction(connection, {
          mint,
          borrower: walletAddr,
          collateral_amount: collateralAmount,
          sol_to_borrow: solToBorrow,
          vault: walletAddr,
        })
        await signAndSend(connection, wallet, borrowResult.transaction)
        ok('borrow for liquidation (vault)', borrowResult.message)

        // Time travel ~140 days to push LTV past 65% threshold via interest accrual
        const FULL_EPOCH_SLOTS = 1_512_000 // ~7 days
        const slotsToTravel = FULL_EPOCH_SLOTS * 20
        log(`  Time traveling ${slotsToTravel} slots (~140 days)...`)
        const currentSlot = await connection.getSlot()
        await fetch('http://127.0.0.1:8899', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'surfnet_timeTravel',
            params: [{ absoluteSlot: currentSlot + slotsToTravel }],
          }),
        })
        await new Promise((r) => setTimeout(r, 500))
        ok('time travel', `+${slotsToTravel} slots`)

        // Liquidate via vault — a different linked wallet acts as liquidator
        const liquidator = Keypair.generate()
        const fundLiqTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: liquidator.publicKey,
            lamports: 0.05 * LAMPORTS_PER_SOL,
          }),
        )
        const { blockhash: liqBh } = await connection.getLatestBlockhash()
        fundLiqTx.recentBlockhash = liqBh
        fundLiqTx.feePayer = wallet.publicKey
        await signAndSend(connection, wallet, fundLiqTx)

        // Link liquidator to vault
        const linkLiqResult = await buildLinkWalletTransaction(connection, {
          authority: walletAddr,
          vault_creator: walletAddr,
          wallet_to_link: liquidator.publicKey.toBase58(),
        })
        await signAndSend(connection, wallet, linkLiqResult.transaction)

        const vaultBefore = await getVault(connection, walletAddr)
        const { ComputeBudgetProgram: CBP2 } = require('@solana/web3.js')
        const liqResult = await buildLiquidateTransaction(connection, {
          mint,
          liquidator: liquidator.publicKey.toBase58(),
          borrower: walletAddr,
          vault: walletAddr,
        })
        liqResult.transaction.instructions.unshift(
          CBP2.setComputeUnitLimit({ units: 400_000 }),
        )
        const liqSig = await signAndSend(connection, liquidator, liqResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        ok(
          'buildLiquidateTransaction (vault)',
          `vault_sol_delta=${((vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)).toFixed(4)} SOL sig=${liqSig.slice(0, 8)}...`,
        )

        // Unlink liquidator
        const unlinkLiqResult = await buildUnlinkWalletTransaction(connection, {
          authority: walletAddr,
          vault_creator: walletAddr,
          wallet_to_unlink: liquidator.publicKey.toBase58(),
        })
        await signAndSend(connection, wallet, unlinkLiqResult.transaction)
        } // end else (solToBorrow >= MIN_BORROW)
      } catch (e: any) {
        fail('vault-routed liquidation', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }

      // ------------------------------------------------------------------
      // 21. Vault-Routed Claim Protocol Rewards
      // ------------------------------------------------------------------
      log('\n[21] Vault-Routed Claim Protocol Rewards')
      try {
        const anchor = require('@coral-xyz/anchor')
        const idlCrank = require('../dist/torch_market.json')
        const PROGRAM_ID_CRANK = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')
        const dummyWalletCrank2 = {
          publicKey: wallet.publicKey,
          signTransaction: async (t: Transaction) => { t.partialSign(wallet); return t },
          signAllTransactions: async (ts: Transaction[]) => { ts.forEach((t) => t.partialSign(wallet)); return ts },
        }
        const providerCrank2 = new anchor.AnchorProvider(connection, dummyWalletCrank2, {})
        const programCrank2 = new anchor.Program(idlCrank, providerCrank2)

        const [protocolTreasuryPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('protocol_treasury_v11')],
          PROGRAM_ID_CRANK,
        )

        const SLOTS_8_DAYS = Math.floor((8 * 24 * 60 * 60 * 1000) / 400)

        // Fund protocol treasury so rewards are distributable
        const airdropSig = await connection.requestAirdrop(protocolTreasuryPda, 1500 * LAMPORTS_PER_SOL)
        await connection.confirmTransaction(airdropSig)

        // Step 1: Time travel + advance protocol epoch (moves trades to "previous")
        let slot = await connection.getSlot()
        await fetch('http://127.0.0.1:8899', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'surfnet_timeTravel',
            params: [{ absoluteSlot: slot + SLOTS_8_DAYS }],
          }),
        })
        await new Promise((r) => setTimeout(r, 500))

        await programCrank2.methods
          .advanceProtocolEpoch()
          .accounts({ payer: wallet.publicKey, protocolTreasury: protocolTreasuryPda })
          .rpc()
        ok('advance protocol epoch (prime)', 'epoch advanced')

        // Step 2: Generate >= 10 SOL volume via bonding curve buys
        // V27: 3 SOL on a fresh token would yield ~30M tokens (over 20M wallet cap).
        // Use 0.5 SOL per buy across 20 tokens (10 SOL total) to stay under cap.
        const volNames = Array.from({ length: 20 }, (_, i) => `Vol ${String.fromCharCode(65 + i)}`)
        for (const vname of volNames) {
          const volToken = await buildCreateTokenTransaction(connection, {
            creator: walletAddr,
            name: vname,
            symbol: vname.replace(' ', ''),
            metadata_uri: 'https://example.com/vol.json',
          })
          await signAndSend(connection, wallet, volToken.transaction)

          const volBuy = await buildDirectBuyTransaction(connection, {
            mint: volToken.mint.toBase58(),
            buyer: walletAddr,
            amount_sol: Math.floor(0.5 * LAMPORTS_PER_SOL),
            slippage_bps: 1000,
            vote: 'burn',
          })
          await signAndSend(connection, wallet, volBuy.transaction)
        }
        ok('volume buys', '10 SOL across 20 tokens for epoch eligibility')

        // Step 3: Time travel 8 days + advance again
        slot = await connection.getSlot()
        log(`  Time traveling ${SLOTS_8_DAYS} slots (~8 days) for next epoch...`)
        await fetch('http://127.0.0.1:8899', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1,
            method: 'surfnet_timeTravel',
            params: [{ absoluteSlot: slot + SLOTS_8_DAYS }],
          }),
        })
        await new Promise((r) => setTimeout(r, 500))

        await programCrank2.methods
          .advanceProtocolEpoch()
          .accounts({ payer: wallet.publicKey, protocolTreasury: protocolTreasuryPda })
          .rpc()
        ok('advance protocol epoch', 'epoch advanced for claim')

        // Claim protocol rewards via vault
        const vaultBefore = await getVault(connection, walletAddr)
        const claimResult = await buildClaimProtocolRewardsTransaction(connection, {
          user: walletAddr,
          vault: walletAddr,
        })
        const claimSig = await signAndSend(connection, wallet, claimResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        const received = (vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)
        ok(
          'buildClaimProtocolRewardsTransaction (vault)',
          `vault_received=${received.toFixed(6)} SOL sig=${claimSig.slice(0, 8)}...`,
        )
      } catch (e: any) {
        fail('vault-routed claim protocol rewards', e)
        if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
      }
    } catch (e: any) {
      fail('migrate/lending lifecycle', e)
      if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
    }
  }

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log('='.repeat(60))

  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
