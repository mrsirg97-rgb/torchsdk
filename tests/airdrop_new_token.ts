/**
 * Airdrop New Token-2022 Token
 *
 * Distributes a new Token-2022 token to holders from a snapshot file,
 * proportionally based on their percentage holdings.
 *
 * Usage:
 *   npx tsx tests/airdrop_new_token.ts <NEW_MINT> <SNAPSHOT_JSON>              # dry run
 *   npx tsx tests/airdrop_new_token.ts <NEW_MINT> <SNAPSHOT_JSON> --execute    # send transfers
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// ============================================================================
// Config
// ============================================================================

const MAINNET_RPC = 'https://torch-market-rpc.mrsirg97.workers.dev'
const WALLET_PATH = path.join(os.homedir(), 'Projects/burnfun/torch_market/keys/mainnet-deploy-wallet.json')
const TOKEN_DECIMALS = 6
const DUST_THRESHOLD = 1_000_000 // 1 token in raw units (10^6)

// ============================================================================
// Helpers
// ============================================================================

const loadWallet = (): Keypair => {
  const raw = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf-8'))
  return Keypair.fromSecretKey(Uint8Array.from(raw))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

// ============================================================================
// Main
// ============================================================================

interface SnapshotEntry {
  wallet: string
  balance: number
  percent: number
}

async function main() {
  const newMintArg = process.argv[2]
  const snapshotArg = process.argv[3]
  const executeMode = process.argv.includes('--execute')

  if (!newMintArg || !snapshotArg) {
    console.error('Usage: npx tsx tests/airdrop_new_token.ts <NEW_MINT> <SNAPSHOT_JSON> [--execute]')
    process.exit(1)
  }

  const newMint = new PublicKey(newMintArg)
  const connection = new Connection(MAINNET_RPC, 'confirmed')
  const authority = loadWallet()

  // Load snapshot
  const snapshotPath = path.resolve(snapshotArg)
  if (!fs.existsSync(snapshotPath)) {
    console.error(`Snapshot file not found: ${snapshotPath}`)
    process.exit(1)
  }
  const snapshot: SnapshotEntry[] = JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'))

  console.log('='.repeat(60))
  console.log('AIRDROP NEW TOKEN-2022 TOKEN')
  console.log('='.repeat(60))
  log(`Authority: ${authority.publicKey.toBase58()}`)
  log(`New mint:  ${newMintArg}`)
  log(`Snapshot:  ${snapshotPath} (${snapshot.length} holders)`)
  log(`Mode:      ${executeMode ? 'EXECUTE' : 'DRY RUN'}`)

  // Read authority's Token-2022 ATA balance
  const authorityAta = getAssociatedTokenAddressSync(
    newMint,
    authority.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  )

  let authorityBalance: bigint
  try {
    const account = await getAccount(connection, authorityAta, 'confirmed', TOKEN_2022_PROGRAM_ID)
    authorityBalance = BigInt(account.amount.toString())
  } catch {
    console.error('Authority does not have a Token-2022 ATA for this mint. Create one and fund it first.')
    process.exit(1)
  }

  log(`Authority token balance: ${Number(authorityBalance) / 10 ** TOKEN_DECIMALS}`)

  // Calculate distribution — use snapshot percentages directly (already clamped to 0.1%–2%)
  interface AirdropRecipient {
    wallet: string
    amount: bigint
    percent: number
  }

  const recipients: AirdropRecipient[] = []
  let totalDistribute = BigInt(0)

  for (const entry of snapshot) {
    const amount = BigInt(Math.floor(Number(authorityBalance) * (entry.percent / 100)))

    if (amount < BigInt(DUST_THRESHOLD)) {
      continue // skip dust
    }

    recipients.push({
      wallet: entry.wallet,
      amount,
      percent: entry.percent,
    })
    totalDistribute += amount
  }

  // Sort by amount descending
  recipients.sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))

  // Print distribution table
  const W = 44
  const A = 20
  const P = 10
  console.log(`\n${'='.repeat(W + A + P + 4)}`)
  console.log(`${'Wallet'.padEnd(W)}  ${'Tokens'.padStart(A)}  ${'%'.padStart(P)}`)
  console.log(`${'-'.repeat(W)}  ${'-'.repeat(A)}  ${'-'.repeat(P)}`)

  for (const r of recipients) {
    const tokenAmount = Number(r.amount) / 10 ** TOKEN_DECIMALS
    console.log(
      `${r.wallet.padEnd(W)}  ${tokenAmount.toFixed(2).padStart(A)}  ${r.percent.toFixed(4).padStart(P)}`,
    )
  }

  const skipped = snapshot.length - recipients.length
  console.log(`${'-'.repeat(W)}  ${'-'.repeat(A)}  ${'-'.repeat(P)}`)
  console.log(`${recipients.length} recipients, ${skipped} skipped (dust < 1 token)`)
  console.log(`Total to distribute: ${Number(totalDistribute) / 10 ** TOKEN_DECIMALS} tokens`)
  console.log(`Authority will retain: ${Number(authorityBalance - totalDistribute) / 10 ** TOKEN_DECIMALS} tokens`)

  if (!executeMode) {
    console.log('\nDRY RUN — pass --execute to send transfers')
    process.exit(0)
  }

  // Execute transfers — batch 2 recipients per tx
  console.log('\n--- EXECUTING AIRDROP ---')
  log('Waiting 5 seconds before starting... (Ctrl+C to cancel)')
  await sleep(5000)

  const BATCH_SIZE = 2
  let sent = 0
  let failed = 0

  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE)
    const tx = new Transaction()

    for (const r of batch) {
      const recipientPk = new PublicKey(r.wallet)
      const recipientAta = getAssociatedTokenAddressSync(
        newMint,
        recipientPk,
        true,
        TOKEN_2022_PROGRAM_ID,
      )

      // Create ATA if needed (idempotent)
      tx.add(
        createAssociatedTokenAccountIdempotentInstruction(
          authority.publicKey,
          recipientAta,
          recipientPk,
          newMint,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      )

      // Transfer
      tx.add(
        createTransferCheckedInstruction(
          authorityAta,
          newMint,
          recipientAta,
          authority.publicKey,
          r.amount,
          TOKEN_DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID,
        ),
      )
    }

    const { blockhash } = await connection.getLatestBlockhash()
    tx.recentBlockhash = blockhash
    tx.feePayer = authority.publicKey

    try {
      const sig = await signAndSend(connection, authority, tx)
      sent += batch.length
      log(`  [${sent}/${recipients.length}] ${sig}`)
    } catch (e: any) {
      failed += batch.length
      log(`  FAILED batch at index ${i}: ${(e.message || '').substring(0, 100)}`)
    }

    if (i + BATCH_SIZE < recipients.length) {
      await sleep(500)
    }
  }

  console.log('\n' + '='.repeat(60))
  console.log(`AIRDROP COMPLETE`)
  console.log('='.repeat(60))
  console.log(`  Sent:   ${sent}`)
  console.log(`  Failed: ${failed}`)

  // Final authority balance
  try {
    const finalAccount = await getAccount(connection, authorityAta, 'confirmed', TOKEN_2022_PROGRAM_ID)
    log(`Authority remaining balance: ${Number(finalAccount.amount) / 10 ** TOKEN_DECIMALS}`)
  } catch {
    log('Could not read final authority balance')
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFatal error:', err)
    process.exit(1)
  })
