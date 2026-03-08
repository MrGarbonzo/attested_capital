/**
 * Signal Blender — 3-layer blend of strategy + sentiment signals.
 *
 * Layer 0: Fallback — if sentiment is null, pass through strategy signal unchanged.
 * Layer 1: Weighted score — 40% strategy + 60% sentiment → buy/sell/hold.
 * Layer 2: AI veto — sentiment can veto a buy or force a sell.
 * Layer 3: Extreme override — high-confidence extreme events can force trades.
 */
import type { StrategySignal } from '../strategies/types.js';
import { clampPositionSize } from '../strategies/index.js';
import type { SentimentSignal, BlendedSignal, BlendWeights } from './sentiment-types.js';
import { DEFAULT_BLEND_WEIGHTS } from './sentiment-types.js';

function actionToNumeric(action: string): number {
  if (action === 'buy') return 1;
  if (action === 'sell') return -1;
  return 0;
}

function magnitudeToSize(magnitude: number): number {
  // Map absolute magnitude [0, 1] to position size [5, 30]
  return 5 + Math.abs(magnitude) * 25;
}

export function blendSignals(
  strategy: StrategySignal,
  sentiment: SentimentSignal | null,
  weights?: Partial<BlendWeights>,
): BlendedSignal {
  const w: BlendWeights = { ...DEFAULT_BLEND_WEIGHTS, ...weights };

  // ── Layer 0: Fallback — no sentiment data ──────────────────
  if (!sentiment) {
    return {
      action: strategy.action,
      size: strategy.size,
      reason: `[fallback] ${strategy.reason}`,
      blendLayer: 'fallback',
      strategyScore: actionToNumeric(strategy.action),
      sentimentScore: 0,
      sentimentConfidence: 0,
    };
  }

  const stratNum = actionToNumeric(strategy.action);
  const { score: sentScore, confidence: sentConf } = sentiment;

  // ── Layer 3: Extreme override (checked first, highest priority) ──
  if (
    sentConf >= w.extremeThreshold &&
    Math.abs(sentScore) >= w.extremeScoreMin &&
    sentiment.extremeEvent !== null
  ) {
    const extremeAction = sentScore > 0 ? 'buy' : 'sell';
    const extremeSize = 15; // Fixed 15% for extreme events
    return {
      action: extremeAction as 'buy' | 'sell',
      size: extremeSize,
      reason: `[extreme_override] ${sentiment.extremeEvent} — sentiment ${sentScore.toFixed(2)} conf ${sentConf.toFixed(2)}`,
      blendLayer: 'extreme_override',
      strategyScore: stratNum,
      sentimentScore: sentScore,
      sentimentConfidence: sentConf,
    };
  }

  // ── Layer 1: Weighted score ────────────────────────────────
  const finalScore = w.strategyWeight * stratNum + w.sentimentWeight * sentScore;

  let action: 'buy' | 'sell' | 'hold';
  if (finalScore > w.buyThreshold) {
    action = 'buy';
  } else if (finalScore < w.sellThreshold) {
    action = 'sell';
  } else {
    action = 'hold';
  }

  let size = action !== 'hold' ? magnitudeToSize(finalScore) : undefined;

  // ── Layer 2: AI veto ───────────────────────────────────────
  let blendLayer: BlendedSignal['blendLayer'] = 'weighted';

  // Veto buy if sentiment is bearish with high confidence
  if (action === 'buy' && sentScore < -0.3 && sentConf >= w.vetoConfidence) {
    action = 'hold';
    size = undefined;
    blendLayer = 'veto';
  }

  // Force sell if hold but sentiment is strongly bearish with high confidence
  if (action === 'hold' && sentScore < -0.5 && sentConf >= w.vetoConfidence) {
    action = 'sell';
    size = magnitudeToSize(sentScore);
    blendLayer = 'veto';
  }

  // ── Sentiment-based size scaling ───────────────────────────
  if (size !== undefined) {
    if (sentScore > 0.3) {
      size = size * (1 + 0.3 * sentConf);
    } else if (sentScore < -0.3) {
      size = size * (1 - 0.3 * sentConf);
    }
    size = clampPositionSize(Math.round(size));
  }

  const reason = blendLayer === 'veto'
    ? `[veto] Sentiment overrode: strategy=${strategy.action}, sentiment=${sentScore.toFixed(2)} conf=${sentConf.toFixed(2)} — ${sentiment.reasoning}`
    : `[weighted] score=${finalScore.toFixed(3)} (strat=${stratNum}*${w.strategyWeight}+sent=${sentScore.toFixed(2)}*${w.sentimentWeight}) — ${sentiment.reasoning}`;

  return {
    action,
    size,
    reason,
    blendLayer,
    strategyScore: stratNum,
    sentimentScore: sentScore,
    sentimentConfidence: sentConf,
  };
}
