/**
 * SDK E2E Test against Surfpool (mainnet fork)
 *
 * Tests: create token → vault lifecycle → buy (direct + vault) → sell → star → messages
 * Then: bond to completion → migrate → borrow → repay → vault swap (buy + sell)
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
  buildBorrowTransaction,
  buildRepayTransaction,
  buildCreateVaultTransaction,
  buildDepositVaultTransaction,
  buildWithdrawVaultTransaction,
  buildWithdrawTokensTransaction,
  buildLinkWalletTransaction,
  buildUnlinkWalletTransaction,
  buildVaultSwapTransaction,
  confirmTransaction,
  createEphemeralAgent,
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
    const result = await buildBuyTransaction(connection, {
      mint,
      buyer: walletAddr,
      amount_sol: 2_000_000_000, // 2 SOL (enough tokens for later vault borrow test)
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
      const result = await buildDirectBuyTransaction(connection, {
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

        // Use 60% of vault tokens as collateral, borrow conservatively within 50% LTV
        const collateralAmount = Math.floor(totalTokens * 0.6)

        const vaultBefore = await getVault(connection, walletAddr)
        const borrowResult = await buildBorrowTransaction(connection, {
          mint,
          borrower: walletAddr,
          collateral_amount: collateralAmount,
          sol_to_borrow: 100_000_000, // 0.1 SOL (minimum)
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
