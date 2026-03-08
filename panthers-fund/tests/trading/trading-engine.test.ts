import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';

describe('Trading Engine — Database Layer', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
    // Seed some NFT accounts for P&L distribution
    db.createNFTAccount(1, 'tg_1', 'addr_1', 50000);  // $500
    db.createNFTAccount(2, 'tg_2', 'addr_2', 30000);  // $300
    db.createNFTAccount(3, 'tg_3', 'addr_3', 20000);  // $200
    // Total pool: $1000 = 100000 cents
  });

  describe('Open Positions', () => {
    it('opens a position', () => {
      const pos = db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 145.50,
        amount_cents: 15000,
        token_amount_raw: '103400000', // lamports
        entry_signature: 'sig_open_1',
        strategy: 'ema_crossover',
      });

      expect(pos.id).toBeDefined();
      expect(pos.pair).toBe('SOL/USDC');
      expect(pos.amount_cents).toBe(15000);
      expect(pos.strategy).toBe('ema_crossover');
    });

    it('retrieves open positions', () => {
      db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 145.50,
        amount_cents: 15000,
        token_amount_raw: '103400000',
        entry_signature: 'sig_1',
        strategy: 'ema_crossover',
      });

      const positions = db.getOpenPositions();
      expect(positions).toHaveLength(1);
      expect(positions[0].pair).toBe('SOL/USDC');
    });

    it('filters positions by pair', () => {
      db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 145.50,
        amount_cents: 15000,
        token_amount_raw: '103400000',
        entry_signature: 'sig_1',
        strategy: 'ema_crossover',
      });

      expect(db.getOpenPositions('SOL/USDC')).toHaveLength(1);
      expect(db.getOpenPositions('ETH/USDC')).toHaveLength(0);
    });

    it('closes a position', () => {
      const pos = db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 145.50,
        amount_cents: 15000,
        token_amount_raw: '103400000',
        entry_signature: 'sig_1',
        strategy: 'ema_crossover',
      });

      const closed = db.closePosition(pos.id!);
      expect(closed.id).toBe(pos.id);
      expect(db.getOpenPositions()).toHaveLength(0);
    });

    it('closes all positions for a pair', () => {
      db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 145,
        amount_cents: 10000,
        token_amount_raw: '69000000',
        entry_signature: 'sig_1',
        strategy: 'ema_crossover',
      });
      db.openPosition({
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price_usd: 146,
        amount_cents: 5000,
        token_amount_raw: '34000000',
        entry_signature: 'sig_2',
        strategy: 'ema_crossover',
      });

      const closed = db.closeAllPositions('SOL/USDC');
      expect(closed).toHaveLength(2);
      expect(db.getOpenPositions()).toHaveLength(0);
    });

    it('cannot open position when fund is paused', () => {
      // Cause a pause by breaking invariants manually
      db.db.prepare(`UPDATE fund_state SET is_paused = 1 WHERE id = 1`).run();

      expect(() =>
        db.openPosition({
          pair: 'SOL/USDC',
          direction: 'long',
          entry_price_usd: 145,
          amount_cents: 10000,
          token_amount_raw: '69000000',
          entry_signature: 'sig_1',
          strategy: 'ema_crossover',
        }),
      ).toThrow(/paused/i);
    });
  });

  describe('Daily Trade Stats', () => {
    it('returns zero stats when no trades', () => {
      const stats = db.getDailyTradeStats();
      expect(stats.tradeCount).toBe(0);
      expect(stats.totalPnlCents).toBe(0);
    });

    it('counts trades for today', () => {
      db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 14500,
        exit_price: 15000,
        amount: 10000,
        profit_loss: 500,
        signature: 'sig_1',
        attestation: 'attest_1',
      });

      db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 15000,
        exit_price: 14800,
        amount: 10000,
        profit_loss: -200,
        signature: 'sig_2',
        attestation: 'attest_2',
      });

      const stats = db.getDailyTradeStats();
      expect(stats.tradeCount).toBe(2);
      expect(stats.totalPnlCents).toBe(300); // 500 + (-200)
    });
  });

  describe('Strategy Config', () => {
    it('returns default config when not set', () => {
      const config = db.getStrategyConfig();
      expect(config.activeStrategy).toBe('none');
      expect(config.parameters).toEqual({});
    });

    it('saves and retrieves strategy config', () => {
      db.setStrategyConfig('ema_crossover', { fast_ema: 12, slow_ema: 26, position_size: 15 });

      const config = db.getStrategyConfig();
      expect(config.activeStrategy).toBe('ema_crossover');
      expect(config.parameters.fast_ema).toBe(12);
      expect(config.parameters.slow_ema).toBe(26);
    });

    it('updates fund_state.active_strategy in sync', () => {
      db.setStrategyConfig('rsi_mean_reversion', { rsi_period: 14 });

      const fundState = db.getFundState();
      expect(fundState.active_strategy).toBe('rsi_mean_reversion');
    });
  });

  describe('Full Trade Cycle (DB layer)', () => {
    it('records trade, distributes P&L, and verifies invariants', () => {
      const trade = db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 14500,
        exit_price: 15500,
        amount: 15000,
        profit_loss: 1000, // +$10
        signature: 'sig_trade_1',
        attestation: 'attest_1',
      });

      expect(trade.id).toBeDefined();
      expect(trade.profit_loss).toBe(1000);

      // P&L should be distributed proportionally
      const allocations = db.getTradeAllocations(trade.id!);
      expect(allocations.length).toBe(3);

      // Total allocations should equal profit_loss
      const totalAlloc = allocations.reduce((sum, a) => sum + a.pnl_share, 0);
      expect(totalAlloc).toBe(1000);

      // Account 1 (50% of pool) should get ~50% of P&L
      const acct1Alloc = allocations.find((a) => a.token_id === 1)!;
      expect(acct1Alloc.pnl_share).toBe(500);

      // Invariants should still pass
      expect(() => db.verifyInvariants()).not.toThrow();

      // Pool balance should be updated
      const state = db.getFundState();
      expect(state.total_pool_balance).toBe(101000); // 100000 + 1000
    });

    it('handles losing trades correctly', () => {
      const trade = db.recordTrade({
        strategy: 'rsi_mean_reversion',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 15000,
        exit_price: 14000,
        amount: 10000,
        profit_loss: -500, // -$5
        signature: 'sig_loss_1',
        attestation: 'attest_loss_1',
      });

      const allocations = db.getTradeAllocations(trade.id!);
      const totalAlloc = allocations.reduce((sum, a) => sum + a.pnl_share, 0);
      expect(totalAlloc).toBe(-500);

      expect(() => db.verifyInvariants()).not.toThrow();

      const state = db.getFundState();
      expect(state.total_pool_balance).toBe(99500); // 100000 - 500
    });

    it('records multiple trades with running P&L', () => {
      db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 14500,
        exit_price: 15000,
        amount: 10000,
        profit_loss: 500,
        signature: 'sig_1',
        attestation: 'attest_1',
      });

      db.recordTrade({
        strategy: 'ema_crossover',
        pair: 'SOL/USDC',
        direction: 'long',
        entry_price: 15000,
        exit_price: 14700,
        amount: 10000,
        profit_loss: -300,
        signature: 'sig_2',
        attestation: 'attest_2',
      });

      expect(() => db.verifyInvariants()).not.toThrow();

      const state = db.getFundState();
      expect(state.total_pool_balance).toBe(100200); // 100000 + 500 - 300

      // Check individual accounts
      const acct1 = db.getNFTAccount(1)!;
      // Original: 50000. Gained ~250 (50% of 500), lost ~150 (50% of 300)
      expect(acct1.current_balance).toBe(50100); // exact amounts depend on rounding
    });
  });
});
