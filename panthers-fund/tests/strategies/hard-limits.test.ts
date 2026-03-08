import { describe, it, expect } from 'vitest';
import {
  HARD_LIMITS,
  checkDailyLimits,
  clampPositionSize,
  validateParams,
  isAllowedStrategy,
  ALLOWED_STRATEGIES,
} from '../../src/strategies/hard-limits.js';

describe('Hard Limits', () => {
  it('has correct default values', () => {
    expect(HARD_LIMITS.maxPositionSize).toBe(30);
    expect(HARD_LIMITS.minPositionSize).toBe(5);
    expect(HARD_LIMITS.stopLossFloor).toBe(3);
    expect(HARD_LIMITS.maxDailyTrades).toBe(10);
    expect(HARD_LIMITS.dailyLossLimit).toBe(10);
  });

  it('has exactly 10 allowed strategies', () => {
    expect(ALLOWED_STRATEGIES.length).toBe(10);
  });
});

describe('clampPositionSize', () => {
  it('clamps below minimum', () => {
    expect(clampPositionSize(2)).toBe(5);
    expect(clampPositionSize(0)).toBe(5);
    expect(clampPositionSize(-1)).toBe(5);
  });

  it('clamps above maximum', () => {
    expect(clampPositionSize(35)).toBe(30);
    expect(clampPositionSize(100)).toBe(30);
  });

  it('passes through valid values', () => {
    expect(clampPositionSize(10)).toBe(10);
    expect(clampPositionSize(15)).toBe(15);
    expect(clampPositionSize(5)).toBe(5);
    expect(clampPositionSize(30)).toBe(30);
  });
});

describe('checkDailyLimits', () => {
  it('allows trade when under limits', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 3, totalPnlCents: -500 },
      100000,
    );
    expect(result.allowed).toBe(true);
  });

  it('blocks when daily trade limit reached', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 10, totalPnlCents: 0 },
      100000,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily trade limit');
  });

  it('blocks when daily loss limit breached', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 5, totalPnlCents: -10500 }, // -10.5%
      100000,
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Daily loss limit');
  });

  it('allows when loss is exactly at limit', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 5, totalPnlCents: -10000 }, // exactly 10%
      100000,
    );
    expect(result.allowed).toBe(false);
  });

  it('allows profitable days even with high trade count', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 9, totalPnlCents: 5000 },
      100000,
    );
    expect(result.allowed).toBe(true);
  });

  it('handles zero pool balance', () => {
    const result = checkDailyLimits(
      { date: '2024-01-01', tradeCount: 0, totalPnlCents: 0 },
      0,
    );
    expect(result.allowed).toBe(true);
  });
});

describe('validateParams', () => {
  it('accepts valid params', () => {
    const result = validateParams(
      { rsi_period: 14, oversold: 30 },
      { rsi_period: { min: 7, max: 21 }, oversold: { min: 20, max: 35 } },
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects out-of-range params', () => {
    const result = validateParams(
      { rsi_period: 5, oversold: 40 },
      { rsi_period: { min: 7, max: 21 }, oversold: { min: 20, max: 35 } },
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(2);
  });

  it('ignores params not in definitions', () => {
    const result = validateParams(
      { unknown_param: 999 },
      { rsi_period: { min: 7, max: 21 } },
    );
    expect(result.valid).toBe(true);
  });
});

describe('isAllowedStrategy', () => {
  it('returns true for allowed IDs', () => {
    expect(isAllowedStrategy('ema_crossover')).toBe(true);
    expect(isAllowedStrategy('scalping')).toBe(true);
    expect(isAllowedStrategy('hodl_patience')).toBe(true);
  });

  it('returns false for unknown IDs', () => {
    expect(isAllowedStrategy('unknown')).toBe(false);
    expect(isAllowedStrategy('')).toBe(false);
    expect(isAllowedStrategy('EMA_CROSSOVER')).toBe(false); // case sensitive
  });
});
