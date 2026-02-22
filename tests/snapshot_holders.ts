/**
 * Snapshot Token Holders
 *
 * Fetches all current holders of a token using Helius DAS and outputs a JSON
 * snapshot preserving original proportions (% of total supply).
 *
 * Clamp rules:
 *   - Max 2% of supply (20M tokens) per holder
 *   - Anyone below 1M tokens gets floored to 1M (0.1%)
 *
 * Usage:
 *   npx tsx tests/snapshot_holders.ts [MINT_ADDRESS]
 *
 * Output: snapshot_<mint_prefix>.json
 */

import * as fs from 'fs'
import * as path from 'path'

// ============================================================================
// Config
// ============================================================================

const DEFAULT_TOKEN_MINT = '22fRDzkMUp8LW7RhPGa17FxifJJr6hR4PqyREAR6jitm'
const HELIUS_RPC = 'https://torch-market-rpc.mrsirg97.workers.dev'
const TOKEN_DECIMALS = 6
const TOTAL_SUPPLY = 1_000_000_000 // 1B tokens
const TOTAL_SUPPLY_RAW = TOTAL_SUPPLY * 10 ** TOKEN_DECIMALS

// Clamp bounds (in tokens)
const MIN_TOKENS = 1_000_000   // 1M tokens = 0.1% of supply
const MAX_TOKENS = 20_000_000  // 20M tokens = 2% of supply

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

interface HolderRow {
  wallet: string
  balance: number
  percent: number
}

async function main() {
  const TOKEN_MINT = process.argv[2] || DEFAULT_TOKEN_MINT

  console.log('='.repeat(60))
  console.log('SNAPSHOT TOKEN HOLDERS')
  console.log('='.repeat(60))
  console.log(`Mint:   ${TOKEN_MINT}`)
  console.log(`RPC:    ${HELIUS_RPC}`)
  console.log(`Cap:    ${(MAX_TOKENS / 1e6).toFixed(0)}M tokens (${((MAX_TOKENS / TOTAL_SUPPLY) * 100).toFixed(1)}%)`)
  console.log(`Floor:  ${(MIN_TOKENS / 1e6).toFixed(0)}M tokens (${((MIN_TOKENS / TOTAL_SUPPLY) * 100).toFixed(1)}%)`)

  console.log('\nFetching holders...')
  const holders = await getTokenHolders(HELIUS_RPC, TOKEN_MINT)
  console.log(`\nFound ${holders.size} unique holders`)

  // Build sorted list — percent of TOTAL SUPPLY (1B)
  const rows: HolderRow[] = []
  holders.forEach((balance, wallet) => {
    rows.push({
      wallet,
      balance,
      percent: (balance / TOTAL_SUPPLY_RAW) * 100,
    })
  })
  rows.sort((a, b) => b.balance - a.balance)

  // Exclude protocol accounts (>25% of supply = bonding curve vault, treasury, etc.)
  const external: HolderRow[] = []
  for (const r of rows) {
    if (r.percent > 25) {
      console.log(`\nExcluding protocol account: ${r.wallet} (${formatTokens(r.balance)} — ${r.percent.toFixed(2)}%)`)
    } else {
      external.push(r)
    }
  }

  // Print raw distribution
  const W = 44
  const B = 14
  const P = 10
  console.log(`\n--- RAW (${external.length} holders, % of 1B total supply) ---`)
  console.log(`${'Wallet'.padEnd(W)}  ${'Balance'.padStart(B)}  ${'%'.padStart(P)}`)
  console.log(`${'-'.repeat(W)}  ${'-'.repeat(B)}  ${'-'.repeat(P)}`)

  for (const r of external) {
    console.log(
      `${r.wallet.padEnd(W)}  ${formatTokens(r.balance).padStart(B)}  ${r.percent.toFixed(4).padStart(P)}`,
    )
  }

  // Apply clamp: keep original %, cap at 2%, floor below 1M to 0.1%
  const minPct = (MIN_TOKENS / TOTAL_SUPPLY) * 100  // 0.1%
  const maxPct = (MAX_TOKENS / TOTAL_SUPPLY) * 100  // 2.0%
  const minRaw = MIN_TOKENS * 10 ** TOKEN_DECIMALS

  const clamped: HolderRow[] = []
  let capped = 0
  let floored = 0

  for (const r of external) {
    let pct = r.percent
    const tokens = r.balance / 10 ** TOKEN_DECIMALS

    if (tokens < MIN_TOKENS) {
      pct = minPct
      floored++
    } else if (pct > maxPct) {
      pct = maxPct
      capped++
    }

    clamped.push({ wallet: r.wallet, balance: r.balance, percent: pct })
  }

  const totalAirdropPct = clamped.reduce((s, r) => s + r.percent, 0)

  console.log(`\n--- AIRDROP DISTRIBUTION ---`)
  console.log(`${'Wallet'.padEnd(W)}  ${'Airdrop %'.padStart(B)}  ${'Raw %'.padStart(P)}  ${'Flag'.padStart(6)}`)
  console.log(`${'-'.repeat(W)}  ${'-'.repeat(B)}  ${'-'.repeat(P)}  ${'-'.repeat(6)}`)

  for (let i = 0; i < clamped.length; i++) {
    const c = clamped[i]
    const raw = external[i]
    let flag = ''
    if (c.percent > raw.percent) flag = 'FLOOR'
    else if (c.percent < raw.percent) flag = 'CAP'
    console.log(
      `${c.wallet.padEnd(W)}  ${(c.percent.toFixed(4) + '%').padStart(B)}  ${raw.percent.toFixed(4).padStart(P)}  ${flag.padStart(6)}`,
    )
  }

  console.log(`${'-'.repeat(W)}  ${'-'.repeat(B)}  ${'-'.repeat(P)}  ${'-'.repeat(6)}`)
  console.log(`\n${clamped.length} holders | Total airdrop: ${totalAirdropPct.toFixed(4)}% of supply`)
  console.log(`  ${capped} capped at ${maxPct}% (${(MAX_TOKENS / 1e6).toFixed(0)}M)`)
  console.log(`  ${floored} floored to ${minPct}% (${(MIN_TOKENS / 1e6).toFixed(0)}M)`)
  console.log(`  ${clamped.length - capped - floored} unchanged (original proportions)`)

  // Write snapshot JSON
  const prefix = TOKEN_MINT.substring(0, 8)
  const outFile = path.join(__dirname, `snapshot_${prefix}.json`)
  fs.writeFileSync(outFile, JSON.stringify(clamped, null, 2))
  console.log(`\nSnapshot saved to ${outFile}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFatal error:', err)
    process.exit(1)
  })
