/**
 * Devnet Auto-Bond Script
 *
 * Distributes SOL from the devnet wallet across many wallets and buys
 * a specified token until bonding completes.
 *
 * Usage:
 *   npx tsx tests/devnet_bond.ts <MINT_ADDRESS>
 *
 * The devnet wallet (~/.config/solana/id.json) must be HLgJzzDmzhjZaspP1MgQJGyrV1tpKuYqXwCrnRRpTaYf
 * and needs ~55 SOL for a Spark token (50 SOL target).
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from '@solana/web3.js'
import { buildDirectBuyTransaction } from '../src/index'
import { fetchTokenRaw } from '../src/tokens'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const DEVNET_RPC = 'https://api.devnet.solana.com'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')
const EXPECTED_WALLET = 'HLgJzzDmzhjZaspP1MgQJGyrV1tpKuYqXwCrnRRpTaYf'

// V27 max buy per wallet at initial price by tier (stays under 2% wallet cap)
// Spark: IVS=18.75 SOL, max ~0.5 SOL → use 0.4 SOL
// Flame: IVS=37.5 SOL, max ~1.0 SOL → use 0.8 SOL
// Torch: IVS=75 SOL, max ~2.0 SOL → use 1.5 SOL
const TIER_CONFIG: Record<string, { buyLamports: number; label: string }> = {
  '50000000000':  { buyLamports: Math.floor(0.4 * LAMPORTS_PER_SOL),  label: 'Spark (50 SOL)' },
  '100000000000': { buyLamports: Math.floor(0.8 * LAMPORTS_PER_SOL),  label: 'Flame (100 SOL)' },
  '200000000000': { buyLamports: Math.floor(1.5 * LAMPORTS_PER_SOL),  label: 'Torch (200 SOL)' },
}
// Legacy (pre-V27) or unknown targets
const DEFAULT_TIER = { buyLamports: Math.floor(0.5 * LAMPORTS_PER_SOL), label: 'Legacy/Unknown' }

// ============================================================================
// Helpers
// ============================================================================

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
  signer: Keypair,
  tx: Transaction,
): Promise<string> => {
  tx.partialSign(signer)
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
  })
  await connection.confirmTransaction(sig, 'confirmed')
  return sig
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  const mintArg = process.argv[2]
  if (!mintArg) {
    console.error('Usage: npx tsx tests/devnet_bond.ts <MINT_ADDRESS>')
    process.exit(1)
  }

  const mintPk = new PublicKey(mintArg)
  const connection = new Connection(DEVNET_RPC, 'confirmed')
  const funder = loadWallet()

  // Verify wallet
  if (funder.publicKey.toBase58() !== EXPECTED_WALLET) {
    console.error(`Expected wallet ${EXPECTED_WALLET}, got ${funder.publicKey.toBase58()}`)
    process.exit(1)
  }

  console.log('='.repeat(60))
  console.log('DEVNET AUTO-BOND')
  console.log('='.repeat(60))
  log(`Funder: ${funder.publicKey.toBase58()}`)
  log(`Mint:   ${mintArg}`)

  // Check funder balance
  const funderBalance = await connection.getBalance(funder.publicKey)
  log(`Balance: ${(funderBalance / LAMPORTS_PER_SOL).toFixed(2)} SOL`)

  // Read token state
  log('\nReading token state...')
  const tokenData = await fetchTokenRaw(connection, mintPk)
  if (!tokenData) {
    console.error('Token not found on devnet!')
    process.exit(1)
  }

  const { bondingCurve: bc } = tokenData
  if (bc.bonding_complete) {
    log('Token bonding already complete!')
    process.exit(0)
  }

  const bondingTarget = bc.bonding_target.toString()
  const realSol = Number(bc.real_sol_reserves.toString())
  const targetLamports = Number(bondingTarget)
  const tier = TIER_CONFIG[bondingTarget] || DEFAULT_TIER
  const solRemaining = (targetLamports - realSol) / LAMPORTS_PER_SOL
  const progressPct = (realSol / targetLamports) * 100

  log(`Tier:     ${tier.label}`)
  log(`Target:   ${(targetLamports / LAMPORTS_PER_SOL).toFixed(0)} SOL`)
  log(`Raised:   ${(realSol / LAMPORTS_PER_SOL).toFixed(4)} SOL (${progressPct.toFixed(1)}%)`)
  log(`Remaining: ~${solRemaining.toFixed(2)} SOL`)
  log(`Buy size: ${(tier.buyLamports / LAMPORTS_PER_SOL).toFixed(2)} SOL per wallet`)

  // Calculate wallets needed (with ~10% overhead for fees + failures)
  const estBuysNeeded = Math.ceil((solRemaining * LAMPORTS_PER_SOL) / tier.buyLamports * 1.15)
  const numWallets = Math.min(estBuysNeeded, 1000) // cap at 1000
  const fundPerWallet = tier.buyLamports + Math.floor(0.01 * LAMPORTS_PER_SOL) // buy + gas/rent
  const totalSolNeeded = numWallets * fundPerWallet
  log(`Wallets needed: ~${numWallets}`)
  log(`Total SOL needed: ~${(totalSolNeeded / LAMPORTS_PER_SOL).toFixed(2)} SOL`)

  if (funderBalance < totalSolNeeded + 1 * LAMPORTS_PER_SOL) {
    console.error(`Insufficient balance! Have ${(funderBalance / LAMPORTS_PER_SOL).toFixed(2)} SOL, need ~${((totalSolNeeded + LAMPORTS_PER_SOL) / LAMPORTS_PER_SOL).toFixed(2)} SOL`)
    process.exit(1)
  }

  // Generate wallets
  log(`\nGenerating ${numWallets} wallets...`)
  const buyers: Keypair[] = []
  for (let i = 0; i < numWallets; i++) buyers.push(Keypair.generate())

  // Fund wallets in batches (devnet has lower tx size limits, use batches of 10)
  log('Funding wallets...')
  const FUND_BATCH = 10
  for (let i = 0; i < buyers.length; i += FUND_BATCH) {
    const batch = buyers.slice(i, i + FUND_BATCH)
    const tx = new Transaction()
    for (const b of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: b.publicKey,
          lamports: fundPerWallet,
        }),
      )
    }
    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = funder.publicKey

    try {
      await signAndSend(connection, funder, tx)
    } catch (e: any) {
      log(`  Funding batch ${i / FUND_BATCH} failed: ${e.message?.substring(0, 80)}`)
      // Retry with smaller batch on devnet rate limits
      await sleep(2000)
      for (const b of batch) {
        try {
          const singleTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: funder.publicKey,
              toPubkey: b.publicKey,
              lamports: fundPerWallet,
            }),
          )
          const { blockhash: bh } = await connection.getLatestBlockhash()
          singleTx.recentBlockhash = bh
          singleTx.feePayer = funder.publicKey
          await signAndSend(connection, funder, singleTx)
        } catch { /* skip */ }
        await sleep(500)
      }
    }

    if ((i + FUND_BATCH) % 100 === 0) {
      log(`  Funded ${Math.min(i + FUND_BATCH, buyers.length)}/${buyers.length}`)
    }
    // Devnet rate limiting — small delay between batches
    await sleep(200)
  }
  log(`  All ${buyers.length} wallets funded`)

  // Buy until bonding completes
  log('\nBuying...')
  let buyCount = 0
  let skipCount = 0
  let bondingComplete = false

  for (const buyer of buyers) {
    if (bondingComplete) break

    try {
      const result = await buildDirectBuyTransaction(connection, {
        mint: mintArg,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: tier.buyLamports,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      // Progress check every 25 buys
      if (buyCount % 25 === 0) {
        const data = await fetchTokenRaw(connection, mintPk)
        const reserves = Number(data?.bondingCurve?.real_sol_reserves?.toString() || '0')
        const complete = data?.bondingCurve?.bonding_complete
        const pct = (reserves / targetLamports) * 100
        log(`  Buy ${buyCount}: ${(reserves / LAMPORTS_PER_SOL).toFixed(2)} SOL (${pct.toFixed(1)}%)${complete ? ' — COMPLETE!' : ''}`)
        if (complete) {
          bondingComplete = true
          break
        }
      }
    } catch (e: any) {
      const msg = e.message || ''
      if (
        msg.includes('BondingComplete') ||
        msg.includes('bonding_complete') ||
        msg.includes('Bonding curve complete')
      ) {
        bondingComplete = true
        break
      }
      skipCount++
      if (skipCount <= 5) {
        log(`  Buy ${buyCount + 1} skipped: ${msg.substring(0, 80)}`)
      }
      // Devnet rate limit backoff
      await sleep(1000)
    }
    // Small delay to avoid devnet rate limits
    await sleep(100)
  }

  // Final status
  let finalData = await fetchTokenRaw(connection, mintPk)
  if (!bondingComplete && finalData?.bondingCurve?.bonding_complete) {
    bondingComplete = true
  }

  // [V28] Recovery: if ephemeral buyers couldn't complete bonding (auto-bundled
  // migration requires ~1.5 SOL buffer they don't have), use funder wallet
  if (!bondingComplete) {
    log('\nAttempting final buy with funder wallet (has SOL for V28 migration buffer)...')
    try {
      const result = await buildDirectBuyTransaction(connection, {
        mint: mintArg,
        buyer: funder.publicKey.toBase58(),
        amount_sol: tier.buyLamports,
        slippage_bps: 1000,
        vote: 'burn',
      })
      await signAndSend(connection, funder, result.transaction)
      bondingComplete = true
      buyCount++
      log('  Final buy succeeded — bonding complete + V28 auto-migration')
    } catch (e: any) {
      if (e.message?.includes('BondingComplete') || e.message?.includes('bonding_complete')) {
        bondingComplete = true
      } else {
        log(`  Final buy failed: ${(e.message || '').substring(0, 80)}`)
      }
    }
    finalData = await fetchTokenRaw(connection, mintPk)
  }

  const finalReserves = Number(finalData?.bondingCurve?.real_sol_reserves?.toString() || '0')
  const finalPct = (finalReserves / targetLamports) * 100

  console.log('\n' + '='.repeat(60))
  if (bondingComplete) {
    console.log('BONDING COMPLETE!')
  } else {
    console.log('BONDING NOT COMPLETE — may need more SOL or wallets')
  }
  console.log('='.repeat(60))
  console.log(`  Buys:     ${buyCount}`)
  console.log(`  Skipped:  ${skipCount}`)
  console.log(`  Reserves: ${(finalReserves / LAMPORTS_PER_SOL).toFixed(4)} SOL (${finalPct.toFixed(1)}%)`)
  console.log(`  Target:   ${(targetLamports / LAMPORTS_PER_SOL).toFixed(0)} SOL`)

  const funderBalanceAfter = await connection.getBalance(funder.publicKey)
  console.log(`  Funder:   ${(funderBalanceAfter / LAMPORTS_PER_SOL).toFixed(2)} SOL remaining`)
  console.log('='.repeat(60))

  process.exit(bondingComplete ? 0 : 1)
}

main().catch((e) => {
  console.error('\nFATAL:', e)
  process.exit(1)
})
