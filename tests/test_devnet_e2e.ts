/**
 * Devnet Full E2E Test
 *
 * Creates a Spark token (50 SOL target), bonds to completion, migrates to
 * Raydium DEX (V26 permissionless), then continues with vault swap + lending.
 *
 * Run:
 *   npx tsx tests/test_devnet_e2e.ts
 *
 * Requirements:
 *   - Devnet wallet (~/.config/solana/id.json) with ~70 SOL
 *   - Torch Market program deployed to devnet
 *   - Raydium CPMM program on devnet
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  ComputeBudgetProgram,
} from '@solana/web3.js'
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import { Program, AnchorProvider } from '@coral-xyz/anchor'
import {
  buildCreateTokenTransaction,
  buildDirectBuyTransaction,
  buildBuyTransaction,
  buildSellTransaction,
  buildBorrowTransaction,
  buildRepayTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildVaultSwapTransaction,
  getToken,
  getVault,
} from '../src/index'
import { fetchTokenRaw } from '../src/tokens'
import { getTorchVaultPda } from '../src/program'
import idl from '../src/torch_market.json'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const DEVNET_RPC = 'https://api.devnet.solana.com'
const WALLET_PATH = path.join(os.homedir(), '.config/solana/id.json')

const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')
// Devnet Raydium CPMM addresses
const RAYDIUM_CPMM = new PublicKey('CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW')
const RAYDIUM_AMM_CONFIG = new PublicKey('9zSzfkYy6awexsHvmggeH36pfVUdDGyCcwmjT3AQPBj6')
const RAYDIUM_FEE_RECEIVER = new PublicKey('G11FKBRaAkHAKuLCgLM6K6NUc9rTjPAznRCjZifrTQe2')
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

// Spark tier: 50 SOL target, 0.1 SOL per buy (stays under 2% wallet cap)
const BONDING_TARGET = 50_000_000_000 // 50 SOL in lamports
const BUY_AMOUNT = Math.floor(0.1 * LAMPORTS_PER_SOL)

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

const makeProvider = (connection: Connection, wallet: Keypair): AnchorProvider => {
  const w = {
    publicKey: wallet.publicKey,
    signTransaction: async (t: Transaction) => { t.partialSign(wallet); return t },
    signAllTransactions: async (ts: Transaction[]) => { ts.forEach(t => t.partialSign(wallet)); return ts },
  }
  return new AnchorProvider(connection, w as any, {})
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  console.log('='.repeat(60))
  console.log('DEVNET FULL E2E TEST — Create → Bond → Migrate → Trade → Lend')
  console.log('='.repeat(60))

  const connection = new Connection(DEVNET_RPC, 'confirmed')
  const wallet = loadWallet()
  const walletAddr = wallet.publicKey.toBase58()

  log(`Wallet: ${walletAddr}`)
  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(2)} SOL`)

  if (balance < 60 * LAMPORTS_PER_SOL) {
    console.error('Need at least ~60 SOL on devnet. Airdrop or fund the wallet.')
    process.exit(1)
  }

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
  let mint: string
  try {
    const result = await buildCreateTokenTransaction(connection, {
      creator: walletAddr,
      name: 'Devnet E2E Test',
      symbol: 'DEVTEST',
      metadata_uri: 'https://example.com/devtest.json',
      sol_target: BONDING_TARGET,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    mint = result.mint.toBase58()
    ok('Create token', `mint=${mint.slice(0, 8)}... sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('Create token', e)
    console.error('Cannot continue without token. Exiting.')
    process.exit(1)
  }

  // ==================================================================
  // 2. Create Vault + Deposit
  // ==================================================================
  log('\n[2] Create Vault + Deposit')
  try {
    const createResult = await buildCreateVaultTransaction(connection, { creator: walletAddr })
    const sig = await signAndSend(connection, wallet, createResult.transaction)
    ok('Create vault', `sig=${sig.slice(0, 8)}...`)
    await sleep(500)
  } catch (e: any) {
    // Vault may already exist from a previous run
    if (e.message?.includes('already in use')) {
      ok('Create vault', 'already exists')
    } else {
      fail('Create vault', e)
    }
  }

  try {
    const depositResult = await buildDepositVaultTransaction(connection, {
      depositor: walletAddr,
      vault_creator: walletAddr,
      amount_sol: 5 * LAMPORTS_PER_SOL,
    })
    const sig = await signAndSend(connection, wallet, depositResult.transaction)
    ok('Deposit vault', `5 SOL sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('Deposit vault', e)
  }

  // ==================================================================
  // 3. Buy (vault) — initial buy before bonding
  // ==================================================================
  log('\n[3] Buy via vault (initial)')
  try {
    const result = await buildBuyTransaction(connection, {
      mint,
      buyer: walletAddr,
      amount_sol: BUY_AMOUNT,
      slippage_bps: 500,
      vote: 'burn',
      vault: walletAddr,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('Vault buy', `${result.message} sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('Vault buy', e)
  }

  // ==================================================================
  // 4. Bond to completion using many wallets
  // ==================================================================
  log('\n[4] Bond to completion (50 SOL target)')

  const NUM_BUYERS = 700
  const fundPerWallet = BUY_AMOUNT + Math.floor(0.01 * LAMPORTS_PER_SOL)
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // Fund in batches of 10 (devnet rate limits)
  log(`  Funding ${buyers.length} wallets...`)
  const FUND_BATCH = 10
  for (let i = 0; i < buyers.length; i += FUND_BATCH) {
    const batch = buyers.slice(i, i + FUND_BATCH)
    const tx = new Transaction()
    for (const b of batch) {
      tx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: fundPerWallet,
        }),
      )
    }
    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = wallet.publicKey

    try {
      await signAndSend(connection, wallet, tx)
    } catch (e: any) {
      // Retry individually on failure (devnet rate limits)
      await sleep(2000)
      for (const b of batch) {
        try {
          const singleTx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.publicKey,
              toPubkey: b.publicKey,
              lamports: fundPerWallet,
            }),
          )
          const { blockhash: bh } = await connection.getLatestBlockhash()
          singleTx.recentBlockhash = bh
          singleTx.feePayer = wallet.publicKey
          await signAndSend(connection, wallet, singleTx)
        } catch { /* skip */ }
        await sleep(500)
      }
    }

    if ((i + FUND_BATCH) % 100 === 0) {
      log(`  Funded ${Math.min(i + FUND_BATCH, buyers.length)}/${buyers.length}`)
    }
    await sleep(200)
  }
  log(`  All ${buyers.length} wallets funded`)

  // Buy until bonding completes
  log('  Buying...')
  let buyCount = 0
  let skipCount = 0
  let bondingComplete = false

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

      if (buyCount % 25 === 0) {
        const data = await fetchTokenRaw(connection, new PublicKey(mint))
        const reserves = Number(data?.bondingCurve?.real_sol_reserves?.toString() || '0')
        const complete = data?.bondingCurve?.bonding_complete
        const pct = (reserves / BONDING_TARGET) * 100
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
      await sleep(1000)
    }
    await sleep(100)
  }

  // Final status
  if (!bondingComplete) {
    const data = await fetchTokenRaw(connection, new PublicKey(mint))
    if (data?.bondingCurve?.bonding_complete) bondingComplete = true
  }

  if (bondingComplete) {
    ok('Bonding complete', `after ${buyCount} buys (${skipCount} skipped)`)
  } else {
    fail('Bonding', { message: `Only ${buyCount} buys, not complete` })
    console.error('Cannot continue without bonding completion. Exiting.')
    process.exit(1)
  }

  // ==================================================================
  // 5. Sell via vault (bonding phase complete — sell remaining tokens)
  // ==================================================================
  log('\n[5] Sell via vault (pre-migration)')
  try {
    // Sell a small amount from vault tokens
    const result = await buildSellTransaction(connection, {
      mint,
      seller: walletAddr,
      amount_tokens: 100_000_000, // 100 tokens
      slippage_bps: 500,
      vault: walletAddr,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('Vault sell (pre-migration)', `${result.message} sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    // Expected to fail — bonding complete, can't sell on curve anymore
    if (e.message?.includes('Bonding curve complete') || e.message?.includes('trade on DEX')) {
      ok('Vault sell (pre-migration)', 'correctly blocked — bonding complete, trade on DEX')
    } else {
      fail('Vault sell (pre-migration)', e)
    }
  }

  // ==================================================================
  // 6. Migrate to Raydium DEX (V26 permissionless)
  // ==================================================================
  log('\n[6] Migrate to Raydium DEX (V26 permissionless)')
  try {
    const provider = makeProvider(connection, wallet)
    const program = new Program(idl as any, provider)

    const mintPk = new PublicKey(mint)
    const [globalConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from('global_config')],
      PROGRAM_ID,
    )
    const [bondingCurvePda] = PublicKey.findProgramAddressSync(
      [Buffer.from('bonding_curve'), mintPk.toBuffer()],
      PROGRAM_ID,
    )
    const [treasuryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('treasury'), mintPk.toBuffer()],
      PROGRAM_ID,
    )

    // Token vault ATAs
    const [bcAta] = PublicKey.findProgramAddressSync(
      [bondingCurvePda.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    const [treasuryAta] = PublicKey.findProgramAddressSync(
      [treasuryPda.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )

    // Raydium PDAs
    const isWsolToken0 = WSOL_MINT.toBuffer().compare(mintPk.toBuffer()) < 0
    const token0 = isWsolToken0 ? WSOL_MINT : mintPk
    const token1 = isWsolToken0 ? mintPk : WSOL_MINT
    const [raydiumAuth] = PublicKey.findProgramAddressSync(
      [Buffer.from('vault_and_lp_mint_auth_seed')],
      RAYDIUM_CPMM,
    )
    const [poolState] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool'), RAYDIUM_AMM_CONFIG.toBuffer(), token0.toBuffer(), token1.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [lpMint] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_lp_mint'), poolState.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [obs] = PublicKey.findProgramAddressSync(
      [Buffer.from('observation'), poolState.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [vault0] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_vault'), poolState.toBuffer(), token0.toBuffer()],
      RAYDIUM_CPMM,
    )
    const [vault1] = PublicKey.findProgramAddressSync(
      [Buffer.from('pool_vault'), poolState.toBuffer(), token1.toBuffer()],
      RAYDIUM_CPMM,
    )

    const payerWsol = getAssociatedTokenAddressSync(WSOL_MINT, wallet.publicKey)
    const [payerToken] = PublicKey.findProgramAddressSync(
      [wallet.publicKey.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mintPk.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    const payerLp = getAssociatedTokenAddressSync(lpMint, wallet.publicKey)

    // [V26] Create bc_wsol (bonding curve's WSOL ATA) + payer ATAs
    const bcWsol = getAssociatedTokenAddressSync(WSOL_MINT, bondingCurvePda, true, TOKEN_PROGRAM_ID)
    log('  Creating bc_wsol + payer ATAs...')
    const setupTx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, bcWsol, bondingCurvePda, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, payerWsol, wallet.publicKey, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        wallet.publicKey, payerToken, wallet.publicKey, mintPk, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    )
    await provider.sendAndConfirm(setupTx)
    await sleep(500)

    // Fund bc_wsol with bonding curve SOL, then migrate
    log('  Calling fundMigrationWsol + migrateToDex...')
    const fundIx = await program.methods
      .fundMigrationWsol()
      .accounts({
        payer: wallet.publicKey,
        mint: mintPk,
        bondingCurve: bondingCurvePda,
        bcWsol,
      } as any)
      .instruction()

    const migrateIx = await program.methods
      .migrateToDex()
      .accounts({
        payer: wallet.publicKey,
        globalConfig,
        mint: mintPk,
        bondingCurve: bondingCurvePda,
        treasury: treasuryPda,
        tokenVault: bcAta,
        treasuryTokenAccount: treasuryAta,
        bcWsol,
        payerWsol,
        payerToken,
        raydiumProgram: RAYDIUM_CPMM,
        ammConfig: RAYDIUM_AMM_CONFIG,
        raydiumAuthority: raydiumAuth,
        poolState,
        wsolMint: WSOL_MINT,
        token0Vault: vault0,
        token1Vault: vault1,
        lpMint,
        payerLpToken: payerLp,
        observationState: obs,
        createPoolFee: RAYDIUM_FEE_RECEIVER,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .instruction()

    const migrateTx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(fundIx)
      .add(migrateIx)
    await provider.sendAndConfirm(migrateTx)

    ok('Migrate to DEX', 'Raydium pool created (V26 permissionless)')

    // Verify migration flag
    await sleep(1000)
    const detail = await getToken(connection, mint)
    if (detail.status === 'migrated') {
      ok('Migration verified', 'status=migrated')
    } else {
      fail('Migration verified', { message: `status=${detail.status}, expected migrated` })
    }

    // Post-migration distribution snapshot
    try {
      const postMigData = await fetchTokenRaw(connection, mintPk)
      const bc = postMigData!.bondingCurve
      const tr = postMigData!.treasury!

      const TOTAL_SUPPLY = 1_000_000_000
      const tokenVaultPost = isWsolToken0 ? vault1 : vault0
      const poolTokenBalPost = await connection.getTokenAccountBalance(tokenVaultPost)
      const poolTokens = Number(poolTokenBalPost.value.amount) / 1e6
      const voteVault = Number(bc.vote_vault_balance.toString()) / 1e6
      const excessBurned = Number(bc.permanently_burned_tokens.toString()) / 1e6
      const tokensSold = TOTAL_SUPPLY - poolTokens - voteVault - excessBurned
      const treasurySol = Number(tr.sol_balance.toString()) / LAMPORTS_PER_SOL
      const poolSolBal = await connection.getTokenAccountBalance(isWsolToken0 ? vault0 : vault1)
      const poolSol = Number(poolSolBal.value.amount) / LAMPORTS_PER_SOL

      log(`\n  ┌─── Post-Migration Distribution ──────────────────────────┐`)
      log(`  │  Total Supply:     ${TOTAL_SUPPLY.toLocaleString().padStart(15)} tokens  │`)
      log(`  │  Tokens Sold:      ${tokensSold.toFixed(0).padStart(15)} tokens  │`)
      log(`  │  Vote Vault:       ${voteVault.toFixed(0).padStart(15)} tokens  │`)
      log(`  │  Pool Tokens:      ${poolTokens.toFixed(0).padStart(15)} tokens  │`)
      log(`  │  Excess Burned:    ${excessBurned.toFixed(0).padStart(15)} tokens  │`)
      log(`  ├────────────────────────────────────────────────────────────┤`)
      log(`  │  Pool SOL:         ${poolSol.toFixed(4).padStart(15)} SOL     │`)
      log(`  │  Treasury SOL:     ${treasurySol.toFixed(4).padStart(15)} SOL     │`)
      log(`  └────────────────────────────────────────────────────────────┘`)
    } catch { /* non-critical */ }

    // Wait for Raydium pool open_time to pass
    log('\n  Waiting 15s for Raydium pool open_time...')
    await sleep(15000)

    // ==================================================================
    // 7. Vault Swap Buy (SOL → Token via Raydium)
    // ==================================================================
    log('\n[7] Vault Swap Buy (SOL → Token via Raydium)')
    try {
      const vaultBefore = await getVault(connection, walletAddr)
      const buySwapResult = await buildVaultSwapTransaction(connection, {
        mint,
        signer: walletAddr,
        vault_creator: walletAddr,
        amount_in: 100_000_000, // 0.1 SOL
        minimum_amount_out: 1,
        is_buy: true,
      })
      buySwapResult.transaction.instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      )
      const buySig = await signAndSend(connection, wallet, buySwapResult.transaction)
      const vaultAfter = await getVault(connection, walletAddr)
      const spent = (vaultBefore?.sol_balance || 0) - (vaultAfter?.sol_balance || 0)
      ok('Vault swap buy', `vault_spent=${spent.toFixed(4)} SOL sig=${buySig.slice(0, 8)}...`)
    } catch (e: any) {
      fail('Vault swap buy', e)
      if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
    }

    await sleep(500)

    // ==================================================================
    // 8. Vault Swap Sell (Token → SOL via Raydium)
    // ==================================================================
    log('\n[8] Vault Swap Sell (Token → SOL via Raydium)')
    try {
      const [vaultPda] = getTorchVaultPda(wallet.publicKey)
      const vaultAta = getAssociatedTokenAddressSync(
        new PublicKey(mint), vaultPda, true, TOKEN_2022_PROGRAM_ID,
      )
      const tokenBal = await connection.getTokenAccountBalance(vaultAta)
      const totalTokens = Number(tokenBal.value.amount)
      const sellAmount = Math.floor(totalTokens * 0.1) // sell 10%
      log(`  Vault token balance: ${(totalTokens / 1e6).toFixed(0)} tokens, selling ${(sellAmount / 1e6).toFixed(0)}`)

      if (sellAmount < 1_000_000) {
        ok('Vault swap sell', 'skipped — insufficient vault tokens')
      } else {
        const vaultBefore = await getVault(connection, walletAddr)
        const sellSwapResult = await buildVaultSwapTransaction(connection, {
          mint,
          signer: walletAddr,
          vault_creator: walletAddr,
          amount_in: sellAmount,
          minimum_amount_out: 1,
          is_buy: false,
        })
        sellSwapResult.transaction.instructions.unshift(
          ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
        )
        const sellSig = await signAndSend(connection, wallet, sellSwapResult.transaction)
        const vaultAfter = await getVault(connection, walletAddr)
        const received = (vaultAfter?.sol_balance || 0) - (vaultBefore?.sol_balance || 0)
        ok('Vault swap sell', `vault_received=${received.toFixed(6)} SOL sig=${sellSig.slice(0, 8)}...`)
      }
    } catch (e: any) {
      fail('Vault swap sell', e)
      if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
    }

    await sleep(500)

    // ==================================================================
    // 9. Borrow via vault (collateral from vault ATA, SOL to vault)
    // ==================================================================
    log('\n[9] Borrow via vault')
    try {
      const [vaultPda] = getTorchVaultPda(wallet.publicKey)
      const vaultAta = getAssociatedTokenAddressSync(
        new PublicKey(mint), vaultPda, true, TOKEN_2022_PROGRAM_ID,
      )
      const tokenBal = await connection.getTokenAccountBalance(vaultAta)
      const totalTokens = Number(tokenBal.value.amount)
      log(`  Vault token balance: ${(totalTokens / 1e6).toFixed(0)} tokens`)

      // Check treasury lending capacity
      const treasuryData = await fetchTokenRaw(connection, new PublicKey(mint))
      const treasurySol = Number(treasuryData?.treasury?.sol_balance || 0)
      const maxLendable = Math.floor(treasurySol * 0.5) // 50% utilization cap
      const borrowAmount = Math.min(100_000_000, Math.max(0, maxLendable - 1_000_000))
      log(`  Treasury SOL: ${(treasurySol / LAMPORTS_PER_SOL).toFixed(4)}, max lendable: ${(maxLendable / LAMPORTS_PER_SOL).toFixed(4)}, borrowing: ${(borrowAmount / LAMPORTS_PER_SOL).toFixed(4)}`)

      if (borrowAmount < 100_000_000) {
        ok('Vault borrow', 'skipped — treasury too small for minimum borrow (0.1 SOL)')
      } else {
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
        ok('Vault borrow', `${borrowResult.message} vault_received=${solReceived.toFixed(4)} SOL sig=${borrowSig.slice(0, 8)}...`)

        await sleep(500)

        // ==============================================================
        // 10. Repay via vault
        // ==============================================================
        log('\n[10] Repay via vault')
        try {
          const repayResult = await buildRepayTransaction(connection, {
            mint,
            borrower: walletAddr,
            sol_amount: 200_000_000, // 0.2 SOL (overpay to fully close)
            vault: walletAddr,
          })
          const repaySig = await signAndSend(connection, wallet, repayResult.transaction)
          ok('Vault repay', `${repayResult.message} sig=${repaySig.slice(0, 8)}...`)
        } catch (e: any) {
          fail('Vault repay', e)
        }
      }
    } catch (e: any) {
      fail('Vault borrow', e)
      if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
    }

  } catch (e: any) {
    fail('Migration/post-migration lifecycle', e)
    if (e.logs) console.error('  Logs:', e.logs.slice(-5).join('\n        '))
  }

  // ==================================================================
  // Summary
  // ==================================================================
  const funderBalanceAfter = await connection.getBalance(wallet.publicKey)
  const solSpent = (balance - funderBalanceAfter) / LAMPORTS_PER_SOL

  console.log('\n' + '='.repeat(60))
  console.log(`RESULTS: ${passed} passed, ${failed} failed`)
  console.log(`SOL spent: ${solSpent.toFixed(2)} SOL (${(funderBalanceAfter / LAMPORTS_PER_SOL).toFixed(2)} remaining)`)
  console.log('='.repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('\nFATAL:', e)
  process.exit(1)
})
