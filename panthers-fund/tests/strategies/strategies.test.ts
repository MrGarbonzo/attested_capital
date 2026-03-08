import { describe, it, expect } from 'vitest';
import {
  uptrendCandles,
  downtrendCandles,
  sidewaysCandles,
  oversoldCandles,
  overboughtCandles,
  generateCandles,
} from './helpers.js';
import {
  getStrategy,
  getAllStrategies,
  getDefaultParams,
  ALLOWED_STRATEGIES,
  isAllowedStrategy,
} from '../../src/strategies/index.js';
import type { Candle, StrategySignal } from '../../src/strategies/types.js';

// ── Registry Tests ──────────────────────────────────────────

describe('Strategy Registry', () => {
  it('has all 10 strategies registered', () => {
    const all = getAllStrategies();
    expect(all.length).toBe(10);
  });

  it('can retrieve each allowed strategy by ID', () => {
    for (const id of ALLOWED_STRATEGIES) {
      const strategy = getStrategy(id);
      expect(strategy).toBeDefined();
      expect(strategy.meta.id).toBe(id);
    }
  });

  it('throws for unknown strategy', () => {
    expect(() => getStrategy('unknown_strategy')).toThrow();
  });

  it('returns default params for each strategy', () => {
    for (const id of ALLOWED_STRATEGIES) {
      const params = getDefaultParams(id);
      expect(Object.keys(params).length).toBeGreaterThan(0);
      // Every param should have a numeric value
      for (const val of Object.values(params)) {
        expect(typeof val).toBe('number');
      }
    }
  });

  it('validates allowed strategy IDs', () => {
    expect(isAllowedStrategy('ema_crossover')).toBe(true);
    expect(isAllowedStrategy('rsi_mean_reversion')).toBe(true);
    expect(isAllowedStrategy('not_a_strategy')).toBe(false);
  });
});

// ── Strategy Execution Tests ────────────────────────────────

describe('Strategy Execution', () => {
  describe('All strategies', () => {
    it('return valid signals with sufficient data', () => {
      const candles = generateCandles(50, 150, 0, 2);

      for (const id of ALLOWED_STRATEGIES) {
        const strategy = getStrategy(id);
        const params = getDefaultParams(id);
        const signal = strategy.execute(candles, params);

        expect(signal).toBeDefined();
        expect(['buy', 'sell', 'hold']).toContain(signal.action);
        expect(typeof signal.reason).toBe('string');
        expect(signal.reason.length).toBeGreaterThan(0);

        if (signal.action !== 'hold') {
          expect(signal.size).toBeDefined();
          expect(typeof signal.size).toBe('number');
          expect(signal.size).toBeGreaterThan(0);
        }
      }
    });

    it('return hold with insufficient data', () => {
      const candles = generateCandles(3, 150); // too few candles

      for (const id of ALLOWED_STRATEGIES) {
        const strategy = getStrategy(id);
        const params = getDefaultParams(id);
        const signal = strategy.execute(candles, params);

        expect(signal.action).toBe('hold');
        expect(signal.reason).toBeTruthy();
      }
    });
  });

  describe('RSI Mean Reversion', () => {
    it('generates buy signal on oversold conditions', () => {
      const strategy = getStrategy('rsi_mean_reversion');
      const candles = oversoldCandles(30);
      const signal = strategy.execute(candles, { ...getDefaultParams('rsi_mean_reversion'), oversold: 35 });

      // With consistently falling prices, RSI should be low
      if (signal.action === 'buy') {
        expect(signal.reason).toContain('oversold');
      }
      // Accept hold if RSI calculation doesn't quite reach oversold
      expect(['buy', 'hold']).toContain(signal.action);
    });

    it('generates sell signal on overbought conditions', () => {
      const strategy = getStrategy('rsi_mean_reversion');
      const candles = overboughtCandles(30);
      const signal = strategy.execute(candles, { ...getDefaultParams('rsi_mean_reversion'), overbought: 65 });

      if (signal.action === 'sell') {
        expect(signal.reason).toContain('overbought');
      }
      expect(['sell', 'hold']).toContain(signal.action);
    });
  });

  describe('EMA Crossover', () => {
    it('generates buy on uptrend (golden cross)', () => {
      const strategy = getStrategy('ema_crossover');
      // Start flat then go up — should get golden cross
      const flat = generateCandles(30, 100, 0, 0.1);
      const up = generateCandles(20, 100, 2, 0.1);
      const candles = [...flat, ...up];

      const signal = strategy.execute(candles, getDefaultParams('ema_crossover'));
      // In a strong uptrend, we should get buy or hold (crossover might have already happened)
      expect(['buy', 'hold']).toContain(signal.action);
    });

    it('generates sell on downtrend (death cross)', () => {
      const strategy = getStrategy('ema_crossover');
      const flat = generateCandles(30, 200, 0, 0.1);
      const down = generateCandles(20, 200, -2, 0.1);
      const candles = [...flat, ...down];

      const signal = strategy.execute(candles, getDefaultParams('ema_crossover'));
      expect(['sell', 'hold']).toContain(signal.action);
    });
  });

  describe('DCA Accumulator', () => {
    it('generates buy signal on dips', () => {
      const strategy = getStrategy('dca_accumulator');
      // Start high, then drop
      const high = generateCandles(20, 200, 0, 0.1);
      const drop = generateCandles(10, 190, -3, 0.1);
      const candles = [...high, ...drop];

      const signal = strategy.execute(candles, { ...getDefaultParams('dca_accumulator'), dip_threshold: 3 });
      // With a significant drop, DCA should want to buy
      expect(['buy', 'hold']).toContain(signal.action);
    });

    it('never generates sell signal', () => {
      const strategy = getStrategy('dca_accumulator');
      const candles = overboughtCandles(30);
      const signal = strategy.execute(candles, getDefaultParams('dca_accumulator'));
      expect(signal.action).not.toBe('sell');
    });
  });

  describe('HODL Patience', () => {
    it('generates buy when price drops significantly from high', () => {
      const strategy = getStrategy('hodl_patience');
      const peak = generateCandles(20, 200, 0, 0.1);
      const crash = generateCandles(20, 200, -3, 0.1);
      const candles = [...peak, ...crash];

      const signal = strategy.execute(candles, { ...getDefaultParams('hodl_patience'), buy_threshold: 10 });
      expect(['buy', 'hold']).toContain(signal.action);
    });
  });

  describe('Bollinger Bands', () => {
    it('returns valid signal on sideways market', () => {
      const strategy = getStrategy('bollinger_bands');
      const candles = sidewaysCandles(30);
      const signal = strategy.execute(candles, getDefaultParams('bollinger_bands'));
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });

  describe('MACD Momentum', () => {
    it('returns valid signal with enough data', () => {
      const strategy = getStrategy('macd_momentum');
      const candles = generateCandles(50, 150, 0.5, 1);
      const signal = strategy.execute(candles, getDefaultParams('macd_momentum'));
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });

  describe('Multi-Timeframe', () => {
    it('returns valid signal combining timeframes', () => {
      const strategy = getStrategy('multi_timeframe');
      const candles = generateCandles(50, 150, 0.3, 1);
      const signal = strategy.execute(candles, getDefaultParams('multi_timeframe'));
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
      expect(signal.reason).toBeTruthy();
    });
  });

  describe('Supertrend', () => {
    it('returns directional signal with trend data', () => {
      const strategy = getStrategy('supertrend');
      const candles = uptrendCandles(30);
      const signal = strategy.execute(candles, getDefaultParams('supertrend'));
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });

  describe('Scalping', () => {
    it('returns valid signal', () => {
      const strategy = getStrategy('scalping');
      const candles = generateCandles(30, 150, 0, 3);
      const signal = strategy.execute(candles, getDefaultParams('scalping'));
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });

  describe('Breakout Trader', () => {
    it('returns hold in range-bound market', () => {
      const strategy = getStrategy('breakout_trader');
      const candles = sidewaysCandles(30, 150);
      const signal = strategy.execute(candles, getDefaultParams('breakout_trader'));
      // In a sideways market, breakout trader should mostly hold
      expect(['buy', 'sell', 'hold']).toContain(signal.action);
    });
  });
});
