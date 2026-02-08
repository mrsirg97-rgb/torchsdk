/**
 * SDK E2E Test against Surfpool (mainnet fork)
 *
 * Tests: create → buy → sell → star → message → getToken → getMessages → listTokens
 * Then: bond to completion → migrate → borrow → repay
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
  buildBuyTransaction,
  buildSellTransaction,
  buildCreateTokenTransaction,
  buildStarTransaction,
  buildMessageTransaction,
  buildBorrowTransaction,
  buildRepayTransaction,
  confirmTransaction,
} from '../src/index'
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
  // 2. Get Token
  // ------------------------------------------------------------------
  log('\n[2] Get Token')
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
  // 3. List Tokens
  // ------------------------------------------------------------------
  log('\n[3] List Tokens')
  try {
    const result = await getTokens(connection, { status: 'bonding', limit: 10 })
    const found = result.tokens.some((t) => t.mint === mint)
    if (!found) throw new Error('Newly created token not found in list')
    ok('getTokens', `total=${result.total} found_new_token=true`)
  } catch (e: any) {
    fail('getTokens', e)
  }

  // ------------------------------------------------------------------
  // 4. Buy Token
  // ------------------------------------------------------------------
  log('\n[4] Buy Token')
  let buySig: string | undefined
  try {
    const result = await buildBuyTransaction(connection, {
      mint,
      buyer: walletAddr,
      amount_sol: 100_000_000, // 0.1 SOL
      slippage_bps: 500,
      vote: 'burn',
    })
    buySig = await signAndSend(connection, wallet, result.transaction)
    ok('buildBuyTransaction', `${result.message} sig=${buySig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildBuyTransaction', e)
  }

  // ------------------------------------------------------------------
  // 5. Sell Token
  // ------------------------------------------------------------------
  log('\n[5] Sell Token')
  try {
    // Sell a small amount (1000 tokens = 1000 * 1e6 base units)
    const result = await buildSellTransaction(connection, {
      mint,
      seller: walletAddr,
      amount_tokens: 1000_000_000, // 1000 tokens
      slippage_bps: 500,
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('buildSellTransaction', `${result.message} sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildSellTransaction', e)
  }

  // ------------------------------------------------------------------
  // 6. Star Token (need a different wallet — can't star your own)
  // ------------------------------------------------------------------
  log('\n[6] Star Token')
  const starrer = Keypair.generate()
  try {
    // Fund starrer
    const fundTx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: starrer.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    )
    const { blockhash } = await connection.getLatestBlockhash()
    fundTx.recentBlockhash = blockhash
    fundTx.feePayer = wallet.publicKey
    await signAndSend(connection, wallet, fundTx)

    const result = await buildStarTransaction(connection, {
      mint,
      user: starrer.publicKey.toBase58(),
    })
    const sig = await signAndSend(connection, starrer, result.transaction)
    ok('buildStarTransaction', `sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildStarTransaction', e)
  }

  // ------------------------------------------------------------------
  // 7. Post Message
  // ------------------------------------------------------------------
  log('\n[7] Post Message')
  try {
    const result = await buildMessageTransaction(connection, {
      mint,
      sender: walletAddr,
      message: 'Hello from SDK e2e test!',
    })
    const sig = await signAndSend(connection, wallet, result.transaction)
    ok('buildMessageTransaction', `sig=${sig.slice(0, 8)}...`)
  } catch (e: any) {
    fail('buildMessageTransaction', e)
  }

  // ------------------------------------------------------------------
  // 8. Get Messages
  // ------------------------------------------------------------------
  log('\n[8] Get Messages')
  try {
    // Wait a moment for the tx to be indexed
    await new Promise((r) => setTimeout(r, 1000))
    const result = await getMessages(connection, mint, 10)
    ok('getMessages', `count=${result.messages.length}`)
  } catch (e: any) {
    fail('getMessages', e)
  }

  // ------------------------------------------------------------------
  // 9. Confirm Transaction (SAID)
  // ------------------------------------------------------------------
  log('\n[9] Confirm Transaction')
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
  // 10. Bond to Completion + Migrate + Borrow + Repay
  // ------------------------------------------------------------------
  log('\n[10] Full Lifecycle: Bond → Migrate → Borrow → Repay')
  log('  Bonding to 200 SOL using multiple wallets (2% wallet cap)...')

  // Generate buyer wallets and fund them
  const NUM_BUYERS = 60
  const BUY_AMOUNT = 5 * LAMPORTS_PER_SOL
  const buyers: Keypair[] = []
  for (let i = 0; i < NUM_BUYERS; i++) buyers.push(Keypair.generate())

  // Fund in batches
  for (let i = 0; i < buyers.length; i += 10) {
    const batch = buyers.slice(i, i + 10)
    const fundTx = new Transaction()
    for (const b of batch) {
      fundTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: b.publicKey,
          lamports: BUY_AMOUNT + 0.1 * LAMPORTS_PER_SOL,
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
      const result = await buildBuyTransaction(connection, {
        mint,
        buyer: buyer.publicKey.toBase58(),
        amount_sol: BUY_AMOUNT,
        slippage_bps: 1000,
        vote: Math.random() > 0.5 ? 'burn' : 'return',
      })
      await signAndSend(connection, buyer, result.transaction)
      buyCount++

      if (buyCount % 10 === 0) {
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

  // Migrate to Raydium (this requires direct Anchor call — not in the SDK)
  if (bondingComplete) {
    log('  Migrating to Raydium DEX (via Anchor directly)...')
    try {
      // We need to use Anchor for migration since it's not an agent operation
      const anchor = require('@coral-xyz/anchor')
      const {
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID: T22,
        ASSOCIATED_TOKEN_PROGRAM_ID: ATP,
        getAssociatedTokenAddressSync,
        createAssociatedTokenAccountInstruction,
        createSyncNativeInstruction,
      } = require('@solana/spl-token')

      const idl = require('../dist/torch_market.json')
      const PROGRAM_ID = new PublicKey('8hbUkonssSEEtkqzwM7ZcZrD9evacM92TcWSooVF4BeT')
      const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C')
      const RAYDIUM_AMM_CONFIG = new PublicKey('D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2')
      const RAYDIUM_FEE_RECEIVER = new PublicKey('DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8')
      const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112')

      const dummyWallet = {
        publicKey: wallet.publicKey,
        signTransaction: async (t: Transaction) => {
          t.partialSign(wallet)
          return t
        },
        signAllTransactions: async (ts: Transaction[]) => {
          ts.forEach((t) => t.partialSign(wallet))
          return ts
        },
      }
      const provider = new anchor.AnchorProvider(connection, dummyWallet, {})
      const program = new anchor.Program(idl, provider)

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
        [bondingCurvePda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
        ATP,
      )
      const [treasuryAta] = PublicKey.findProgramAddressSync(
        [treasuryPda.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
        ATP,
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
        [wallet.publicKey.toBuffer(), T22.toBuffer(), mintPk.toBuffer()],
        ATP,
      )
      const payerLp = getAssociatedTokenAddressSync(lpMint, wallet.publicKey)

      // Create WSOL ATA + fund it
      try {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            payerWsol,
            wallet.publicKey,
            WSOL_MINT,
            TOKEN_PROGRAM_ID,
            ATP,
          ),
        )
        await provider.sendAndConfirm(tx)
      } catch {
        /* exists */
      }

      const fundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: payerWsol,
          lamports: 250 * LAMPORTS_PER_SOL,
        }),
        createSyncNativeInstruction(payerWsol, TOKEN_PROGRAM_ID),
      )
      await provider.sendAndConfirm(fundTx)

      // Create payer Token-2022 ATA
      try {
        const tx = new Transaction().add(
          createAssociatedTokenAccountInstruction(
            wallet.publicKey,
            payerToken,
            wallet.publicKey,
            mintPk,
            T22,
            ATP,
          ),
        )
        await provider.sendAndConfirm(tx)
      } catch {
        /* exists */
      }

      const { ComputeBudgetProgram } = require('@solana/web3.js')
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
          token2022Program: T22,
          associatedTokenProgram: ATP,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction()

      const migrateTx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
        .add(migrateIx)
      await provider.sendAndConfirm(migrateTx)

      ok('migrate to DEX', 'Raydium pool created')

      // ------------------------------------------------------------------
      // 10b. Borrow (use a buyer wallet that has ~5 SOL worth of tokens)
      // ------------------------------------------------------------------
      log('\n  Testing borrow...')
      // Pick first buyer that still has tokens
      const borrowerWallet = buyers[0]
      const borrowerAddr = borrowerWallet.publicKey.toBase58()

      // Fund borrower with extra SOL for tx fees
      const extraFundTx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: borrowerWallet.publicKey,
          lamports: 1 * LAMPORTS_PER_SOL,
        }),
      )
      const { blockhash: efBh } = await connection.getLatestBlockhash()
      extraFundTx.recentBlockhash = efBh
      extraFundTx.feePayer = wallet.publicKey
      await signAndSend(connection, wallet, extraFundTx)

      try {
        // Read borrower's token balance to calculate safe borrow amount
        const { getAssociatedTokenAddressSync: gata } = require('@solana/spl-token')
        const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
        const borrowerAta = gata(new PublicKey(mint), borrowerWallet.publicKey, false, TOKEN_2022)
        const tokenBal = await connection.getTokenAccountBalance(borrowerAta)
        const totalTokens = Number(tokenBal.value.amount)
        log(`  Borrower token balance: ${(totalTokens / 1e6).toFixed(0)} tokens`)

        // Use 60% of tokens as collateral, borrow 0.5 SOL
        const collateralAmount = Math.floor(totalTokens * 0.6)

        const borrowResult = await buildBorrowTransaction(connection, {
          mint,
          borrower: borrowerAddr,
          collateral_amount: collateralAmount,
          sol_to_borrow: 500_000_000, // 0.5 SOL
        })
        const borrowSig = await signAndSend(connection, borrowerWallet, borrowResult.transaction)
        ok('buildBorrowTransaction', `${borrowResult.message} sig=${borrowSig.slice(0, 8)}...`)

        // ------------------------------------------------------------------
        // 10c. Repay
        // ------------------------------------------------------------------
        log('\n  Testing repay...')
        try {
          const repayResult = await buildRepayTransaction(connection, {
            mint,
            borrower: borrowerAddr,
            sol_amount: 600_000_000, // 0.6 SOL (overpay to fully close)
          })
          const repaySig = await signAndSend(connection, borrowerWallet, repayResult.transaction)
          ok('buildRepayTransaction', `${repayResult.message} sig=${repaySig.slice(0, 8)}...`)
        } catch (e: any) {
          fail('buildRepayTransaction', e)
        }
      } catch (e: any) {
        fail('buildBorrowTransaction', e)
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
