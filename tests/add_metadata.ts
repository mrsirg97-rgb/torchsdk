/**
 * V29: Add Metaplex Metadata to Legacy Tokens
 *
 * Fetches all non-migrated tokens and calls add_metadata on each.
 * Skips tokens that already have Metaplex metadata PDAs.
 * Payer pays ~0.01 SOL rent per token.
 *
 * Usage:
 *   npx tsx tests/add_metadata.ts                   # dry run (default)
 *   npx tsx tests/add_metadata.ts --execute          # actually send transactions
 *   npx tsx tests/add_metadata.ts --execute --devnet # devnet
 *   npx tsx tests/add_metadata.ts <MINT>             # single token dry run
 *   npx tsx tests/add_metadata.ts <MINT> --execute   # single token execute
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import { getTokens, buildAddMetadataTransaction } from '../src/index'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const MAINNET_RPC = 'https://torch-market-rpc.mrsirg97.workers.dev'
const DEVNET_RPC = 'https://api.devnet.solana.com'
const WALLET_PATH = path.join(os.homedir(), 'Projects/burnfun/torch_market/keys/mainnet-deploy-wallet.json')

const METAPLEX_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

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

/** Derive Metaplex metadata PDA */
const getMetadataPda = (mint: PublicKey): PublicKey => {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID,
  )[0]
}

/** Check if a Metaplex metadata PDA already exists on-chain */
const hasMetadata = async (connection: Connection, mint: PublicKey): Promise<boolean> => {
  const pda = getMetadataPda(mint)
  const info = await connection.getAccountInfo(pda)
  return info !== null
}

// ============================================================================
// Main
// ============================================================================

const main = async () => {
  const args = process.argv.slice(2)
  const execute = args.includes('--execute')
  const useDevnet = args.includes('--devnet')
  const singleMint = args.find((a) => !a.startsWith('--'))

  const rpc = useDevnet ? DEVNET_RPC : MAINNET_RPC
  const connection = new Connection(rpc, 'confirmed')
  const wallet = loadWallet()

  log(`Network: ${useDevnet ? 'devnet' : 'mainnet'}`)
  log(`Payer: ${wallet.publicKey.toBase58()}`)
  log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`)

  const balance = await connection.getBalance(wallet.publicKey)
  log(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`)

  // Gather target mints
  let mints: string[]

  if (singleMint) {
    mints = [singleMint]
    log(`Single token mode: ${singleMint}`)
  } else {
    log('Fetching all tokens...')
    const result = await getTokens(connection, { limit: 1000 })
    // Only non-migrated tokens (add_metadata requires mint authority)
    mints = result.tokens
      .filter((t) => t.status !== 'migrated')
      .map((t) => t.mint)
    log(`Found ${mints.length} non-migrated tokens`)
  }

  // Filter out tokens that already have Metaplex metadata
  log('Checking for existing Metaplex metadata...')
  const needsMetadata: string[] = []

  for (const mintStr of mints) {
    const mint = new PublicKey(mintStr)
    const exists = await hasMetadata(connection, mint)
    if (exists) {
      log(`  SKIP ${mintStr.slice(0, 8)}... (metadata exists)`)
    } else {
      needsMetadata.push(mintStr)
    }
  }

  log(`\n${needsMetadata.length} tokens need metadata`)
  const estimatedCost = needsMetadata.length * 0.01
  log(`Estimated cost: ~${estimatedCost.toFixed(3)} SOL`)

  if (needsMetadata.length === 0) {
    log('Nothing to do.')
    return
  }

  if (!execute) {
    log('\nTokens needing metadata:')
    for (const m of needsMetadata) {
      log(`  ${m}`)
    }
    log('\nRe-run with --execute to send transactions.')
    return
  }

  // Execute
  let success = 0
  let failed = 0

  for (const mintStr of needsMetadata) {
    try {
      const result = await buildAddMetadataTransaction(connection, {
        mint: mintStr,
        payer: wallet.publicKey.toBase58(),
      })

      // Debug: print instruction accounts
      const ix = result.transaction.instructions[0]
      log(`  Accounts for ${mintStr.slice(0, 8)}:`)
      for (let i = 0; i < ix.keys.length; i++) {
        log(`    [${i}] ${ix.keys[i].pubkey.toBase58()} writable=${ix.keys[i].isWritable} signer=${ix.keys[i].isSigner}`)
      }
      log(`  Program: ${ix.programId.toBase58()}`)

      result.transaction.partialSign(wallet)
      const sig = await connection.sendRawTransaction(result.transaction.serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      })
      await connection.confirmTransaction(sig, 'confirmed')

      success++
      log(`  OK ${mintStr.slice(0, 8)}... tx: ${sig}`)
    } catch (err: any) {
      failed++
      log(`  FAIL ${mintStr.slice(0, 8)}... ${err.message}`)
      if (err.logs) {
        for (const l of err.logs) log(`    ${l}`)
      }
    }

    // Rate limit
    await sleep(500)
  }

  log(`\nDone. ${success} succeeded, ${failed} failed.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
