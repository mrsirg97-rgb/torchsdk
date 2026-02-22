/**
 * Snapshot Token Holders
 *
 * Fetches all current holders of a failed mainnet token using Helius DAS
 * and outputs a JSON snapshot with wallet, balance, and percentage.
 *
 * Usage:
 *   npx tsx tests/snapshot_holders.ts
 *
 * Output: snapshot_<mint_prefix>.json
 */

import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// Config
// ============================================================================

const TOKEN_MINT = 'GawKda5Vzm34HaDCkQrCLjnGUaQFVuYcTFpkDstNBRtm'
const HELIUS_RPC = 'https://torch-market-rpc.mrsirg97.workers.dev'
const TOKEN_DECIMALS = 6

// ============================================================================
// Helpers
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function formatTokens(raw: number): string {
  const value = raw / 10 ** TOKEN_DECIMALS
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`
  return value.toFixed(2)
}

// ============================================================================
// Fetch holders via Helius DAS
// ============================================================================

async function getTokenHolders(
  rpcUrl: string,
  mint: string,
): Promise<Map<string, number>> {
  const holders = new Map<string, number>()
  let cursor: string | undefined
  let page = 0

  do {
    const body: Record<string, unknown> = {
      jsonrpc: '2.0',
      id: 'holders',
      method: 'getTokenAccounts',
      params: {
        mint,
        limit: 1000,
        options: { showZeroBalance: false },
        ...(cursor ? { cursor } : {}),
      },
    }

    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    const data = await res.json()
    const result = data?.result
    if (!result?.token_accounts) break

    for (const acct of result.token_accounts) {
      const amount = Number(acct.amount)
      if (amount > 0) {
        holders.set(acct.owner, (holders.get(acct.owner) || 0) + amount)
      }
    }

    cursor = result.cursor || undefined
    page++
    console.log(`  Page ${page}: ${result.token_accounts.length} accounts (total ${holders.size} unique owners)`)
    await sleep(250)
  } while (cursor)

  return holders
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log('='.repeat(60))
  console.log('SNAPSHOT TOKEN HOLDERS')
  console.log('='.repeat(60))
  console.log(`Mint: ${TOKEN_MINT}`)
  console.log(`RPC:  ${HELIUS_RPC}`)

  console.log('\nFetching holders...')
  const holders = await getTokenHolders(HELIUS_RPC, TOKEN_MINT)
  console.log(`\nFound ${holders.size} unique holders`)

  // Calculate total supply held
  let totalHeld = 0
  holders.forEach((amount) => {
    totalHeld += amount
  })

  // Build sorted list
  interface HolderRow {
    wallet: string
    balance: number
    percent: number
  }

  const rows: HolderRow[] = []
  holders.forEach((balance, wallet) => {
    rows.push({
      wallet,
      balance,
      percent: (balance / totalHeld) * 100,
    })
  })

  rows.sort((a, b) => b.balance - a.balance)

  // Remove top holder (bonding curve token vault)
  if (rows.length > 0) {
    console.log(`\nExcluding top holder (token vault): ${rows[0].wallet} (${formatTokens(rows[0].balance)})`)
    totalHeld -= rows[0].balance
    rows.shift()
    // Recalculate percentages
    for (const r of rows) {
      r.percent = (r.balance / totalHeld) * 100
    }
  }

  // Print table
  const W = 44
  const B = 18
  const P = 10
  console.log(`\n${'='.repeat(W + B + P + 4)}`)
  console.log(`${'Wallet'.padEnd(W)}  ${'Balance'.padStart(B)}  ${'%'.padStart(P)}`)
  console.log(`${'-'.repeat(W)}  ${'-'.repeat(B)}  ${'-'.repeat(P)}`)

  for (const r of rows) {
    console.log(
      `${r.wallet.padEnd(W)}  ${formatTokens(r.balance).padStart(B)}  ${r.percent.toFixed(4).padStart(P)}`,
    )
  }

  console.log(`${'-'.repeat(W)}  ${'-'.repeat(B)}  ${'-'.repeat(P)}`)
  console.log(`${'TOTAL'.padEnd(W)}  ${formatTokens(totalHeld).padStart(B)}  ${'100.0000'.padStart(P)}`)
  console.log(`\n${rows.length} holders`)

  // Write snapshot JSON
  const prefix = TOKEN_MINT.substring(0, 8)
  const outFile = path.join(__dirname, `snapshot_${prefix}.json`)
  fs.writeFileSync(outFile, JSON.stringify(rows, null, 2))
  console.log(`\nSnapshot saved to ${outFile}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFatal error:', err)
    process.exit(1)
  })
