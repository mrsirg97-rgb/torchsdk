/**
 * Quote calculations
 *
 * Get expected output for buy/sell operations.
 */

import { Connection, PublicKey } from '@solana/web3.js'
import { calculateTokensOut, calculateSolOut, calculatePrice } from './program'
import { LAMPORTS_PER_SOL, TOKEN_MULTIPLIER } from './constants'
import { fetchTokenRaw } from './tokens'
import { BuyQuoteResult, SellQuoteResult } from './types'

/**
 * Get a buy quote: how many tokens for a given SOL amount.
 */
export const getBuyQuote = async (
  connection: Connection,
  mintStr: string,
  amountSolLamports: number,
): Promise<BuyQuoteResult> => {
  const mint = new PublicKey(mintStr)
  const tokenData = await fetchTokenRaw(connection, mint)

  if (!tokenData) {
    throw new Error(`Token not found: ${mintStr}`)
  }

  const { bondingCurve } = tokenData

  if (bondingCurve.bonding_complete) {
    throw new Error('Bonding curve complete, trade on DEX')
  }

  const virtualSol = BigInt(bondingCurve.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bondingCurve.virtual_token_reserves.toString())
  const realSol = BigInt(bondingCurve.real_sol_reserves.toString())
  const bondingTarget = BigInt(bondingCurve.bonding_target.toString())
  const amountSol = BigInt(amountSolLamports)

  const result = calculateTokensOut(amountSol, virtualSol, virtualTokens, realSol, 100, 100, bondingTarget)

  const priceBefore = calculatePrice(virtualSol, virtualTokens)
  const priceAfter = calculatePrice(
    virtualSol + result.solToCurve,
    virtualTokens - result.tokensOut,
  )
  const priceImpact = ((priceAfter - priceBefore) / priceBefore) * 100
  const minOutput = (result.tokensToUser * BigInt(99)) / BigInt(100)

  return {
    input_sol: Number(amountSol),
    output_tokens: Number(result.tokensOut),
    tokens_to_user: Number(result.tokensToUser),
    tokens_to_treasury: Number(result.tokensToCommunity),
    protocol_fee_sol: Number(result.protocolFee),
    price_per_token_sol: (priceBefore * TOKEN_MULTIPLIER) / LAMPORTS_PER_SOL,
    price_impact_percent: priceImpact,
    min_output_tokens: Number(minOutput),
  }
}

/**
 * Get a sell quote: how much SOL for a given token amount.
 */
export const getSellQuote = async (
  connection: Connection,
  mintStr: string,
  amountTokens: number,
): Promise<SellQuoteResult> => {
  const mint = new PublicKey(mintStr)
  const tokenData = await fetchTokenRaw(connection, mint)

  if (!tokenData) {
    throw new Error(`Token not found: ${mintStr}`)
  }

  const { bondingCurve } = tokenData

  if (bondingCurve.bonding_complete) {
    throw new Error('Bonding curve complete, trade on DEX')
  }

  const virtualSol = BigInt(bondingCurve.virtual_sol_reserves.toString())
  const virtualTokens = BigInt(bondingCurve.virtual_token_reserves.toString())
  const tokenAmount = BigInt(amountTokens)

  const result = calculateSolOut(tokenAmount, virtualSol, virtualTokens)

  const priceBefore = calculatePrice(virtualSol, virtualTokens)
  const priceAfter = calculatePrice(virtualSol - result.solOut, virtualTokens + tokenAmount)
  const priceImpact = ((priceBefore - priceAfter) / priceBefore) * 100
  const minOutput = (result.solToUser * BigInt(99)) / BigInt(100)

  return {
    input_tokens: Number(tokenAmount),
    output_sol: Number(result.solToUser),
    protocol_fee_sol: 0,
    price_per_token_sol: (priceBefore * TOKEN_MULTIPLIER) / LAMPORTS_PER_SOL,
    price_impact_percent: priceImpact,
    min_output_sol: Number(minOutput),
  }
}
