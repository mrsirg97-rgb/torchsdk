/**
 * V23 Tiered Bonding Curves — Full Lifecycle Test
 *
 * Creates a Spark token (50 SOL target), bonds to completion,
 * migrates to Raydium, borrows, repays. Verifies the full lifecycle
 * works identically to a 200 SOL token but at the lower target.
 *
 * Run:
 *   surfpool start --network mainnet --no-tui
 *   npx tsx tests/test_tiers.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import {
  buildCreateTokenTransaction,
  buildDirectBuyTransaction,
  buildMigrateTransaction,
  buildBorrowTransaction,
  buildRepayTransaction,
} from '../src/index'
import { fetchTokenRaw } from '../src/tokens'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

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

const main = async () => {
  const connection = new Connection(RPC_URL, 'confirmed')
  const wallet = loadWallet()
  const walletAddr = wallet.publicKey.toBase58()
  log(`Wallet: ${walletAddr}`)

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

  // ==================================================================
  // 1. Create Spark Token (50 SOL target)
  // ==================================================================
  log('\n[1] Create Spark Token (50 SOL target)')
  let sparkMint: string
  try {
    const result = await buildCreateTokenTransaction(connection, {
      creator: walletAddr,
      name: 'Spark Test',
      symbol: 'SPARK',
      metadata_uri: 'https://example.com/spark.json',
      sol_target: 50_000_000_000,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    sparkMint = result.mint.toBase58()
    ok('Create Spark token', `mint=${sparkMint.slice(0, 8)}...`)
  } catch (e: any) {
    fail('Create Spark token', e)
    process.exit(1)
  }

  // ==================================================================
  // 2. Verify bonding target stored correctly
  // ==================================================================
  log('\n[2] Verify bonding target and V25 virtual reserves')
  try {
    const data = await fetchTokenRaw(connection, new PublicKey(sparkMint))
    const bc = data?.bondingCurve as any
    const target = (bc?.bonding_target ?? bc?.bondingTarget)?.toString()
    if (target === '50000000000') {
      ok('bonding_target', `${target} (50 SOL)`)
    } else {
      fail('bonding_target', `expected 50000000000, got ${target}`)
    }

    // V25: Verify virtual reserves — Spark should have IVS=6.25 SOL, IVT=900M tokens
    const ivs = Number((bc?.virtual_sol_reserves ?? bc?.virtualSolReserves)?.toString())
    const ivt = Number((bc?.virtual_token_reserves ?? bc?.virtualTokenReserves)?.toString())
    if (ivs === 6_250_000_000) {
      ok('V25 virtual_sol_reserves', `${ivs} (6.25 SOL)`)
    } else {
      fail('V25 virtual_sol_reserves', `expected 6250000000, got ${ivs}`)
    }
    if (ivt === 900_000_000_000_000) {
      ok('V25 virtual_token_reserves', `${ivt} (900M tokens)`)
    } else {
      fail('V25 virtual_token_reserves', `expected 900000000000000, got ${ivt}`)
    }
  } catch (e: any) {
    fail('bonding_target read', e)
  }

  // ==================================================================
  // 3. Reject invalid tier (75 SOL)
  // ==================================================================
  log('\n[3] Reject invalid bonding target (75 SOL)')
  try {
    const result = await buildCreateTokenTransaction(connection, {
      creator: walletAddr,
      name: 'Bad Tier',
      symbol: 'BAD',
      metadata_uri: 'https://example.com/bad.json',
      sol_target: 75_000_000_000,
    })
    await signAndSend(connection, wallet, result.transaction)
    fail('Reject invalid tier', 'should have thrown')
  } catch (e: any) {
    ok('Reject invalid tier', 'correctly rejected')
  }

  // ==================================================================
  // 4. Bond Spark to completion (50 SOL) using multiple wallets
  // ==================================================================
  log('\n[4] Bond Spark to 50 SOL (multiple wallets, 2% cap)')
  // V25: With IVS=6.25 SOL and IVT=900M, the initial price is very low.
  // A 5 SOL buy would yield ~400M tokens, far exceeding the 2% wallet cap (20M).
  // Max buy at initial price ≈ 0.14 SOL. Use 0.1 SOL buys with many wallets.
  // As the price rises ~81x during bonding, later wallets can absorb more SOL.

  const NUM_BUYERS = 700
  const BUY_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL) // 0.1 SOL per buy
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // Fund buyers in batches of 20
  for (let i = 0; i < buyers.length; i += 20) {
    const batch = buyers.slice(i, i + 20)
    const fundTx = new Transaction()
    for (const b of batch) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: BUY_AMOUNT + Math.floor(0.05 * LAMPORTS_PER_SOL), // buy + gas/rent
        }),
      )
    }
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)
  }
  log(`  Funded ${buyers.length} wallets with ${BUY_AMOUNT / LAMPORTS_PER_SOL} SOL each`)

  let bondingComplete = false
  let buyCount = 0
  for (const buyer of buyers) {
    if (bondingComplete) break
    try {
      const result = await buildDirectBuyTransaction(connection, {
        mint: sparkMint,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: BUY_AMOUNT,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      // Check progress every 50 buys
      if (buyCount % 50 === 0) {
        const data = await fetchTokenRaw(connection, new PublicKey(sparkMint))
        const reserves = Number(data?.bondingCurve?.real_sol_reserves) / LAMPORTS_PER_SOL
        const complete = data?.bondingCurve?.bonding_complete
        log(`  Buy ${buyCount}: reserves=${reserves.toFixed(2)} SOL, complete=${complete}`)
        if (complete) bondingComplete = true
      }
    } catch (e: any) {
      if (
        e.message?.includes('BondingComplete') ||
        e.message?.includes('bonding_complete') ||
        e.message?.includes('Bonding curve complete')
      ) {
        bondingComplete = true
      } else {
        log(`  Buy ${buyCount + 1} skipped: ${e.message?.substring(0, 80)}`)
      }
    }
  }

  // Final status check
  if (!bondingComplete) {
    const data = await fetchTokenRaw(connection, new PublicKey(sparkMint))
    if (data?.bondingCurve?.bonding_complete) bondingComplete = true
  }

  if (bondingComplete) {
    ok('Spark bonding complete', `after ${buyCount} buys`)
  } else {
    fail('Spark bonding', { message: `Only ${buyCount} buys, not complete` })
  }

  // ==================================================================
  // 5. Treasury snapshot before migration
  // ==================================================================
  log('\n[5] Pre-migration treasury snapshot')
  try {
    const data = await fetchTokenRaw(connection, new PublicKey(sparkMint))
    const treasurySol = Number(data?.treasury?.sol_balance) / LAMPORTS_PER_SOL
    const reserves = Number(data?.bondingCurve?.real_sol_reserves) / LAMPORTS_PER_SOL
    const bc = data?.bondingCurve as any
    const target = Number(bc?.bonding_target ?? bc?.bondingTarget) / LAMPORTS_PER_SOL
    ok('Pre-migration', `treasury=${treasurySol.toFixed(4)} SOL, reserves=${reserves.toFixed(4)} SOL, target=${target} SOL`)
    log(`  [info] Treasury/reserves ratio: ${(treasurySol / reserves * 100).toFixed(1)}%`)
    log(`  [info] Estimated migration liquidity: ${(reserves - treasurySol).toFixed(2)} SOL`)
  } catch (e: any) {
    fail('Pre-migration snapshot', e)
  }

  // ==================================================================
  // 6. Migrate to Raydium DEX
  // ==================================================================
  if (!bondingComplete) {
    log('\n[6] Skipping migration — bonding not complete')
  } else {
    log('\n[6] Migrate Spark to Raydium DEX')
    try {
      // Snapshot bonding curve state before migration for price verification
      const { getBondingCurvePda, getRaydiumMigrationAccounts } = require('../src/program')
      const { Program, AnchorProvider } = require('@coral-xyz/anchor')
      const idl = require('../dist/torch_market.json')
      const mintPk = new PublicKey(sparkMint)
      const [bondingCurvePda] = getBondingCurvePda(mintPk)
      const dummyWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async (t: Transaction) => { t.partialSign(wallet); return t },
        signAllTransactions: async (ts: Transaction[]) => { ts.forEach(t => t.partialSign(wallet)); return ts },
      }
      const provider = new AnchorProvider(connection, dummyWallet, {})
      const program = new Program(idl, provider)
      const bcData = await program.account.bondingCurve.fetch(bondingCurvePda)

      // Migrate using SDK
      const migrateResult = await buildMigrateTransaction(connection, {
        mint: sparkMint,
        payer: walletAddr,
      })
      await signAndSend(connection, wallet, migrateResult.transaction)

      ok('Migrate to DEX', 'Raydium pool created for Spark token (V26 permissionless — program wraps SOL internally)')

      // Derive Raydium vault addresses for post-migration verification
      const raydium = getRaydiumMigrationAccounts(mintPk)
      const isWsolToken0 = raydium.isWsolToken0
      const vault0 = raydium.token0Vault
      const vault1 = raydium.token1Vault

      // V25: Post-migration token distribution breakdown
      try {
        const postMigData = await fetchTokenRaw(connection, new PublicKey(sparkMint))
        const bc = postMigData!.bondingCurve
        const tr = postMigData!.treasury!

        const TOTAL_SUPPLY = 1_000_000_000 // 1B tokens (display units)
        const tokenVaultPost = isWsolToken0 ? vault1 : vault0
        const poolTokenBalPost = await connection.getTokenAccountBalance(tokenVaultPost)
        const poolTokens = Number(poolTokenBalPost.value.amount) / 1e6
        const voteVault = Number(bc.vote_vault_balance.toString()) / 1e6
        const excessBurned = Number(bc.permanently_burned_tokens.toString()) / 1e6
        const treasuryTokens = Number(tr.tokens_held.toString()) / 1e6
        const tokensSold = TOTAL_SUPPLY - poolTokens - voteVault - excessBurned
        const treasurySol = Number(tr.sol_balance.toString()) / LAMPORTS_PER_SOL
        const poolSolBal = await connection.getTokenAccountBalance(isWsolToken0 ? vault0 : vault1)
        const poolSol = Number(poolSolBal.value.amount) / LAMPORTS_PER_SOL
        const baselineSol = Number(tr.baseline_sol_reserves.toString()) / LAMPORTS_PER_SOL
        const baselineTokens = Number(tr.baseline_token_reserves.toString()) / 1e6

        // Determine initial virtual reserves for this token's tier
        const bondingTarget = Number(bc.bonding_target.toString())
        let ivs = 30 // legacy default
        let ivt = 107_300_000 // legacy default
        if (bondingTarget === 50_000_000_000) { ivs = 6.25; ivt = 900_000_000 }
        else if (bondingTarget === 100_000_000_000) { ivs = 12.5; ivt = 900_000_000 }
        else if (bondingTarget === 200_000_000_000) { ivs = 25; ivt = 900_000_000 }

        const entryPrice = ivs / ivt
        const exitPrice = poolSol / poolTokens
        const multiplier = exitPrice / entryPrice

        log(`\n  ┌─── V25 Post-Migration Token Distribution ───────────────┐`)
        log(`  │  Total Supply:     ${TOTAL_SUPPLY.toLocaleString().padStart(15)} tokens  │`)
        log(`  │  Tokens Sold:      ${tokensSold.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Vote Vault:       ${voteVault.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Pool Tokens:      ${poolTokens.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Excess Burned:    ${excessBurned.toFixed(0).padStart(15)} tokens  │`)
        log(`  │  Accounted:        ${(tokensSold + voteVault + poolTokens + excessBurned).toFixed(0).padStart(15)} tokens  │`)
        log(`  ├────────────────────────────────────────────────────────────┤`)
        log(`  │  Pool SOL:         ${poolSol.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Treasury SOL:     ${treasurySol.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Baseline SOL:     ${baselineSol.toFixed(4).padStart(15)} SOL     │`)
        log(`  │  Baseline Tokens:  ${baselineTokens.toFixed(0).padStart(15)} tokens  │`)
        log(`  ├────────────────────────────────────────────────────────────┤`)
        log(`  │  Entry Price:      ${entryPrice.toExponential(4).padStart(15)} SOL/tok │`)
        log(`  │  Exit Price:       ${exitPrice.toExponential(4).padStart(15)} SOL/tok │`)
        log(`  │  Multiplier:       ${multiplier.toFixed(1).padStart(15)}x        │`)
        log(`  │  Sold %:           ${((tokensSold / TOTAL_SUPPLY) * 100).toFixed(1).padStart(14)}%         │`)
        log(`  │  Excess Burn %:    ${((excessBurned / TOTAL_SUPPLY) * 100).toFixed(1).padStart(14)}%         │`)
        log(`  └────────────────────────────────────────────────────────────┘`)

        // Verify V25 expectations: ~80% sold, ~11% excess burn, ~81x multiplier
        const soldPct = (tokensSold / TOTAL_SUPPLY) * 100
        const burnPct = (excessBurned / TOTAL_SUPPLY) * 100
        if (soldPct > 70 && soldPct < 95) {
          ok('V25 tokens sold %', `${soldPct.toFixed(1)}% (expected ~80%)`)
        } else {
          fail('V25 tokens sold %', { message: `${soldPct.toFixed(1)}% — expected 70-95%` })
        }
        if (burnPct < 20) {
          ok('V25 excess burn %', `${burnPct.toFixed(1)}% (expected <20%)`)
        } else {
          fail('V25 excess burn %', { message: `${burnPct.toFixed(1)}% — expected <20%` })
        }
        if (multiplier > 50 && multiplier < 120) {
          ok('V25 price multiplier', `${multiplier.toFixed(1)}x (expected ~81x)`)
        } else {
          fail('V25 price multiplier', { message: `${multiplier.toFixed(1)}x — expected 50-120x` })
        }
      } catch (e: any) {
        fail('V25 distribution breakdown', e)
      }

      // Verify migrated flag
      const postMigrate = await fetchTokenRaw(connection, new PublicKey(sparkMint))
      if (postMigrate?.bondingCurve?.migrated) {
        ok('Migration verified', 'bonding_curve.migrated = true')
      } else {
        fail('Migration verified', 'migrated flag not set')
      }

      // Verify pool price matches bonding curve exit price
      log('\n  Verifying pool price matches bonding curve exit price...')
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

      // ==================================================================
      // 7. Borrow against Spark token (lending)
      // ==================================================================
      log('\n[7] Borrow against Spark token')
      try {
        // First need tokens — one of the buyers has tokens from bonding
        // Use wallet's own tokens (from being the creator, they may not have any)
        // Actually, let's use one of the buyers who has tokens
        const borrower = buyers[0]
        const borrowerAddr = borrower.publicKey.toBase58()

        const borrowResult = await buildBorrowTransaction(connection, {
          mint: sparkMint,
          borrower: borrowerAddr,
          collateral_amount: 5_000_000_000_000, // 5M tokens (6 decimals)
          sol_to_borrow: 100_000_000, // 0.1 SOL (minimum)
        })
        await signAndSend(connection, borrower, borrowResult.transaction)
        ok('Borrow', `${borrowResult.message}`)

        // ==============================================================
        // 8. Repay loan
        // ==============================================================
        log('\n[8] Repay loan')
        const repayResult = await buildRepayTransaction(connection, {
          mint: sparkMint,
          borrower: borrowerAddr,
          sol_amount: 200_000_000, // 0.2 SOL (overpay to fully close)
        })
        await signAndSend(connection, borrower, repayResult.transaction)
        ok('Repay', `${repayResult.message}`)
      } catch (e: any) {
        fail('Borrow/Repay lifecycle', e)
      }
    } catch (e: any) {
      fail('Migration/Lending lifecycle', e)
    }
  }

  // ==================================================================
  // Summary
  // ==================================================================
  log(`\n${'='.repeat(50)}`)
  log(`Results: ${passed} passed, ${failed} failed`)
  log(`${'='.repeat(50)}`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
