/**
 * Trading Engine — orchestrates the full 4h trading cycle.
 *
 * Flow:
 * 1. Pre-checks: fund not paused, strategy active, within daily limits
 * 2. Fetch price data (CoinGecko OHLCV)
 * 3. Run active strategy → get signal
 * 4. If signal ≠ hold → execute Jupiter swap
 * 5. Record trade → distribute P&L → verify invariants
 * 6. On failure → auto-pause + alert
 */
import type { ServiceContext } from './context.js';
import { fetchCandles, fetchCurrentSolPrice } from './price-data.js';
import {
  getStrategy,
  getDefaultParams,
  checkDailyLimits,
  clampPositionSize,
  isAllowedStrategy,
  HARD_LIMITS,
  CENTS_TO_USDC_UNITS,
  USDC_MINT,
  SOL_MINT,
  SOL_DECIMALS,
  USDC_DECIMALS,
} from '../strategies/index.js';
import type { StrategySignal, Candle, OpenPosition } from '../strategies/types.js';
import { fetchSentimentData } from './sentiment-fetcher.js';
import { analyzeSentiment } from './sentiment-analyzer.js';
import { blendSignals } from './signal-blender.js';
import type { SentimentSignal, BlendedSignal, BlendWeights } from './sentiment-types.js';

export interface TradingCycleResult {
  action: 'hold' | 'opened' | 'closed' | 'skipped' | 'error';
  reason: string;
  signal?: StrategySignal;
  sentimentSignal?: SentimentSignal;
  blendedSignal?: BlendedSignal;
  tradeId?: number;
  signature?: string;
  pnlCents?: number;
}

/**
 * Run a single trading cycle.
 */
export async function runTradingCycle(ctx: ServiceContext): Promise<TradingCycleResult> {
  // ── 1. Pre-checks ──────────────────────────────────────────
  const fundState = ctx.db.getFundState();

  if (fundState.is_paused) {
    return { action: 'skipped', reason: 'Fund is paused' };
  }

  if (fundState.total_pool_balance === 0) {
    return { action: 'skipped', reason: 'Pool is empty (no NFT holders)' };
  }

  if (fundState.total_nfts_active === 0) {
    return { action: 'skipped', reason: 'No active NFT accounts' };
  }

  const strategyId = fundState.active_strategy;
  if (!strategyId || strategyId === 'none') {
    return { action: 'skipped', reason: 'No active strategy set' };
  }

  if (!isAllowedStrategy(strategyId)) {
    return { action: 'skipped', reason: `Strategy '${strategyId}' is not an allowed strategy` };
  }

  // Check daily limits (with optional governance overrides)
  const dailyStats = ctx.db.getDailyTradeStats();
  const tradingLimitsJson = ctx.db.getConfigValue('trading_limits');
  const governanceLimits = tradingLimitsJson
    ? JSON.parse(tradingLimitsJson) as Record<string, number>
    : undefined;
  const dailyCheck = checkDailyLimits(dailyStats, fundState.total_pool_balance, governanceLimits);
  if (!dailyCheck.allowed) {
    return { action: 'skipped', reason: dailyCheck.reason! };
  }

  // ── 2. Fetch price data ────────────────────────────────────
  let candles: Candle[];
  try {
    candles = await fetchCandles('solana', 30);
  } catch (err) {
    return {
      action: 'error',
      reason: `Price fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (candles.length < 10) {
    return { action: 'skipped', reason: `Insufficient price data (${candles.length} candles)` };
  }

  // ── 3. Run strategy ────────────────────────────────────────
  const strategy = getStrategy(strategyId);
  const config = ctx.db.getStrategyConfig();
  const params = config.activeStrategy === strategyId && Object.keys(config.parameters).length > 0
    ? config.parameters
    : getDefaultParams(strategyId);

  let signal: StrategySignal;
  try {
    signal = strategy.execute(candles, params);
  } catch (err) {
    return {
      action: 'error',
      reason: `Strategy execution failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  console.log(`[trading] Strategy ${strategyId}: ${signal.action} — ${signal.reason}`);

  // ── 4. Sentiment analysis + blending ─────────────────────────
  let sentimentSignal: SentimentSignal | null = null;
  let blended: BlendedSignal;

  try {
    // Fetch sentiment data from Twitter, Telegram, News
    const twitterAccounts = process.env.SENTIMENT_TWITTER_ACCOUNTS?.split(',').filter(Boolean);
    const telegramChannels = process.env.SENTIMENT_TELEGRAM_CHANNELS?.split(',').filter(Boolean);
    const cryptoPanicToken = process.env.CRYPTOPANIC_API_TOKEN;

    const sources = await fetchSentimentData({
      twitterAccounts,
      telegramChannels,
      cryptoPanicToken,
    });

    const totalItems = sources.reduce((sum, s) => sum + s.items.length, 0);
    console.log(`[trading] Sentiment data: ${totalItems} items from ${sources.filter(s => s.items.length > 0).length} sources`);

    // Analyze sentiment with DeepSeek LLM
    if (ctx.sentimentLlm && totalItems > 0) {
      sentimentSignal = await analyzeSentiment(ctx.sentimentLlm, sources);
    }

    // Log sentiment to database
    if (sentimentSignal) {
      try {
        ctx.db.logSentiment({
          score: sentimentSignal.score,
          confidence: sentimentSignal.confidence,
          reasoning: sentimentSignal.reasoning,
          extremeEvent: sentimentSignal.extremeEvent,
          twitterScore: sentimentSignal.sources.twitter.score,
          telegramScore: sentimentSignal.sources.telegram.score,
          newsScore: sentimentSignal.sources.news.score,
          blendLayer: null, // will be set after blending
          strategyAction: signal.action,
          blendedAction: null, // will be set after blending
          rawJson: JSON.stringify(sentimentSignal),
        });
      } catch (logErr) {
        console.warn(`[trading] Failed to log sentiment: ${logErr}`);
      }
    }
  } catch (err) {
    console.warn(`[trading] Sentiment pipeline error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  // Blend strategy + sentiment signals
  const blendWeightsJson = ctx.db.getConfigValue('blend_weights');
  const customWeights = blendWeightsJson
    ? JSON.parse(blendWeightsJson) as Partial<BlendWeights>
    : undefined;

  blended = blendSignals(signal, sentimentSignal, customWeights);
  console.log(`[trading] Blended: ${blended.action} (layer=${blended.blendLayer}) — ${blended.reason}`);

  // Update sentiment log with blend result
  if (sentimentSignal) {
    try {
      // Update the most recent sentiment log entry with blend info
      ctx.db.db.prepare(
        `UPDATE sentiment_log SET blend_layer = ?, blended_action = ?
         WHERE id = (SELECT MAX(id) FROM sentiment_log)`
      ).run(blended.blendLayer, blended.action);
    } catch {
      // non-fatal
    }
  }

  // ── 5. Act on blended signal ─────────────────────────────────
  const effectiveSignal: StrategySignal = {
    action: blended.action,
    size: blended.size,
    reason: blended.reason,
  };

  if (blended.action === 'hold') {
    return { action: 'hold', reason: blended.reason, signal, sentimentSignal: sentimentSignal ?? undefined, blendedSignal: blended };
  }

  const openPositions = ctx.db.getOpenPositions('SOL/USDC');

  if (blended.action === 'buy') {
    const result = await handleBuy(ctx, effectiveSignal, fundState.total_pool_balance, openPositions, strategyId);
    return { ...result, sentimentSignal: sentimentSignal ?? undefined, blendedSignal: blended };
  }

  if (blended.action === 'sell') {
    const result = await handleSell(ctx, effectiveSignal, openPositions, strategyId);
    return { ...result, sentimentSignal: sentimentSignal ?? undefined, blendedSignal: blended };
  }

  return { action: 'hold', reason: 'Unknown action', signal, sentimentSignal: sentimentSignal ?? undefined, blendedSignal: blended };
}

// ── Buy: open a new position ───────────────────────────────

async function handleBuy(
  ctx: ServiceContext,
  signal: StrategySignal,
  poolBalanceCents: number,
  openPositions: OpenPosition[],
  strategyId: string,
): Promise<TradingCycleResult> {
  // Check total open position exposure (with optional governance overrides)
  const tradingLimitsJson = ctx.db.getConfigValue('trading_limits');
  const govLimits = tradingLimitsJson
    ? JSON.parse(tradingLimitsJson) as Record<string, number>
    : undefined;
  const maxPosSize = govLimits?.maxPositionSize !== undefined
    ? Math.min(govLimits.maxPositionSize, HARD_LIMITS.maxPositionSize)
    : HARD_LIMITS.maxPositionSize;

  const totalOpenCents = openPositions.reduce((sum, p) => sum + p.amount_cents, 0);
  const totalExposurePct = (totalOpenCents / poolBalanceCents) * 100;

  if (totalExposurePct >= maxPosSize) {
    return {
      action: 'skipped',
      reason: `Already at max exposure (${totalExposurePct.toFixed(1)}% >= ${maxPosSize}%)`,
      signal,
    };
  }

  // Clamp position size
  const sizePct = clampPositionSize(signal.size ?? 10);
  const positionCents = Math.trunc(poolBalanceCents * sizePct / 100);

  if (positionCents <= 0) {
    return { action: 'skipped', reason: 'Position size too small', signal };
  }

  // Convert cents to USDC on-chain units
  const usdcAmount = String(positionCents * CENTS_TO_USDC_UNITS);

  // Execute Jupiter swap: USDC → SOL
  let signature: string;
  let solReceived: string;
  try {
    const result = await ctx.jupiter.swap({
      inputMint: USDC_MINT,
      outputMint: SOL_MINT,
      amount: usdcAmount,
      slippageBps: 50,
    });
    signature = result.signature;
    solReceived = result.outAmount;
  } catch (err) {
    return {
      action: 'error',
      reason: `Jupiter swap failed: ${err instanceof Error ? err.message : String(err)}`,
      signal,
    };
  }

  // Get current price for record-keeping
  let entryPriceUsd: number;
  try {
    entryPriceUsd = await fetchCurrentSolPrice();
  } catch {
    // Calculate from swap amounts
    const usdcSpent = positionCents / 100; // dollars
    const solAmount = Number(solReceived) / 10 ** SOL_DECIMALS;
    entryPriceUsd = solAmount > 0 ? usdcSpent / solAmount : 0;
  }

  // Record open position in DB
  ctx.db.openPosition({
    pair: 'SOL/USDC',
    direction: 'long',
    entry_price_usd: entryPriceUsd,
    amount_cents: positionCents,
    token_amount_raw: solReceived,
    entry_signature: signature,
    strategy: strategyId,
  });

  console.log(`[trading] Opened position: ${positionCents} cents → ${solReceived} lamports @ $${entryPriceUsd.toFixed(2)}`);

  return {
    action: 'opened',
    reason: `Bought SOL: ${positionCents} cents (${sizePct}%) @ $${entryPriceUsd.toFixed(2)} — ${signal.reason}`,
    signal,
    signature,
  };
}

// ── Sell: close open positions ─────────────────────────────

async function handleSell(
  ctx: ServiceContext,
  signal: StrategySignal,
  openPositions: OpenPosition[],
  strategyId: string,
): Promise<TradingCycleResult> {
  if (openPositions.length === 0) {
    return { action: 'skipped', reason: 'No open positions to sell', signal };
  }

  // Close all open SOL/USDC positions
  let totalPnlCents = 0;
  let lastSignature = '';
  let lastTradeId: number | undefined;

  for (const pos of openPositions) {
    // Execute Jupiter swap: SOL → USDC
    let signature: string;
    let usdcReceived: string;
    try {
      const result = await ctx.jupiter.swap({
        inputMint: SOL_MINT,
        outputMint: USDC_MINT,
        amount: pos.token_amount_raw,
        slippageBps: 50,
      });
      signature = result.signature;
      usdcReceived = result.outAmount;
    } catch (err) {
      console.error(`[trading] Failed to close position ${pos.id}: ${err}`);
      continue; // Try next position
    }

    // Calculate P&L
    const usdcReceivedCents = Math.trunc(Number(usdcReceived) / CENTS_TO_USDC_UNITS);
    const pnlCents = usdcReceivedCents - pos.amount_cents;
    totalPnlCents += pnlCents;

    // Get exit price
    let exitPriceUsd: number;
    try {
      exitPriceUsd = await fetchCurrentSolPrice();
    } catch {
      const solAmount = Number(pos.token_amount_raw) / 10 ** SOL_DECIMALS;
      exitPriceUsd = solAmount > 0 ? (usdcReceivedCents / 100) / solAmount : 0;
    }

    // Record the round-trip trade (entry → exit) with P&L
    try {
      const trade = ctx.db.recordTrade({
        strategy: pos.strategy,
        pair: pos.pair,
        direction: pos.direction,
        entry_price: Math.round(pos.entry_price_usd * 100), // cents
        exit_price: Math.round(exitPriceUsd * 100),          // cents
        amount: pos.amount_cents,
        profit_loss: pnlCents,
        signature,
        attestation: `entry:${pos.entry_signature}|exit:${signature}`,
      });
      lastTradeId = trade.id;
    } catch (err) {
      console.error(`[trading] Failed to record trade for position ${pos.id}: ${err}`);
      // Invariant violation will auto-pause the fund
      throw err;
    }

    // Close the position record
    ctx.db.closePosition(pos.id!);
    lastSignature = signature;

    console.log(`[trading] Closed position ${pos.id}: ${pos.amount_cents}c → ${usdcReceivedCents}c, P&L: ${pnlCents}c`);
  }

  // Verify invariants (already done inside recordTrade, but double-check)
  try {
    ctx.db.verifyInvariants();
  } catch (err) {
    console.error('[trading] Post-trade invariant check failed:', err);
    throw err;
  }

  return {
    action: 'closed',
    reason: `Sold ${openPositions.length} position(s), total P&L: ${totalPnlCents > 0 ? '+' : ''}${totalPnlCents} cents — ${signal.reason}`,
    signal,
    tradeId: lastTradeId,
    signature: lastSignature,
    pnlCents: totalPnlCents,
  };
}
