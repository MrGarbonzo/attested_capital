import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';
import { InvariantViolationError, FundPausedError, AccountNotFoundError } from '../../src/types/errors.js';
import { createTestLedger, seedAccounts, seedAccountsVaried, mockTrade } from './helpers.js';

let ledger: DatabaseLedger;

beforeEach(() => {
  ledger = createTestLedger();
});

afterEach(() => {
  ledger.close();
});

// ── Account CRUD ──────────────────────────────────────────────

describe('Account CRUD', () => {
  it('should create an NFT account with correct balances', () => {
    const acct = ledger.createNFTAccount(1, 'tg_alice', 'addr_alice', 5000);
    expect(acct.token_id).toBe(1);
    expect(acct.owner_telegram_id).toBe('tg_alice');
    expect(acct.initial_deposit).toBe(5000);
    expect(acct.current_balance).toBe(5000);
    expect(acct.total_pnl).toBe(0);
    expect(acct.is_active).toBe(1);
  });

  it('should update fund_state when creating an account', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.createNFTAccount(2, 'tg_2', 'addr_2', 3000);
    const state = ledger.getFundState();
    expect(state.total_pool_balance).toBe(8000);
    expect(state.total_nfts_active).toBe(2);
  });

  it('should query account by token_id', () => {
    ledger.createNFTAccount(5, 'tg_5', 'addr_5', 10000);
    const acct = ledger.getNFTAccount(5);
    expect(acct).not.toBeNull();
    expect(acct!.token_id).toBe(5);
  });

  it('should reject token_id out of range', () => {
    const maxNfts = Number(process.env.MAX_NFTS) || 20;
    expect(() => ledger.createNFTAccount(0, 'tg', 'addr', 5000)).toThrow();
    expect(() => ledger.createNFTAccount(maxNfts + 1, 'tg', 'addr', 5000)).toThrow();
  });

  it('should reject duplicate token_id', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    expect(() => ledger.createNFTAccount(1, 'tg_2', 'addr_2', 5000)).toThrow();
  });

  it('should reject non-positive deposit', () => {
    expect(() => ledger.createNFTAccount(1, 'tg', 'addr', 0)).toThrow();
    expect(() => ledger.createNFTAccount(1, 'tg', 'addr', -100)).toThrow();
  });

  it('should return null for non-existent account', () => {
    expect(ledger.getNFTAccount(999)).toBeNull();
  });

  it('should list all active accounts', () => {
    seedAccounts(ledger, 5, 5000);
    const all = ledger.getAllNFTAccounts(true);
    expect(all).toHaveLength(5);
    expect(all[0].token_id).toBe(1);
    expect(all[4].token_id).toBe(5);
  });
});

// ── Add Funds ─────────────────────────────────────────────────

describe('Add Funds', () => {
  it('should increase initial_deposit and current_balance', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.addFundsToNFT(1, 3000, 'tx_add1');
    const acct = ledger.getNFTAccount(1)!;
    expect(acct.initial_deposit).toBe(8000);
    expect(acct.current_balance).toBe(8000);
  });

  it('should not change total_pnl', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.addFundsToNFT(1, 3000, 'tx_add1');
    const acct = ledger.getNFTAccount(1)!;
    expect(acct.total_pnl).toBe(0);
  });

  it('should record a fund addition entry', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    const addition = ledger.addFundsToNFT(1, 3000, 'tx_add1');
    expect(addition.amount).toBe(3000);
    expect(addition.tx_hash).toBe('tx_add1');
  });

  it('should update fund_state pool balance', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.addFundsToNFT(1, 2000, 'tx_add');
    expect(ledger.getFundState().total_pool_balance).toBe(7000);
  });

  it('should reject adding funds to non-existent account', () => {
    expect(() => ledger.addFundsToNFT(999, 1000, 'tx')).toThrow(AccountNotFoundError);
  });

  it('should reject adding funds to inactive (withdrawn) account', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.recordWithdrawal(1, 'dest', 'tx_w');
    expect(() => ledger.addFundsToNFT(1, 1000, 'tx')).toThrow(AccountNotFoundError);
  });

  it('should maintain invariants after adding funds + trade', () => {
    seedAccounts(ledger, 3, 5000);
    ledger.addFundsToNFT(2, 5000, 'tx_add');
    ledger.recordTrade(mockTrade({ profit_loss: 1000 }));
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });
});

// ── Trade P&L Distribution ────────────────────────────────────

describe('Trade P&L Distribution', () => {
  it('should distribute profit proportionally to 2 accounts', () => {
    seedAccountsVaried(ledger, [6000, 4000]); // 60/40 split
    ledger.recordTrade(mockTrade({ profit_loss: 1000 }));

    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    expect(a1.current_balance).toBe(6600); // 6000 + 600
    expect(a2.current_balance).toBe(4400); // 4000 + 400
  });

  it('should distribute losses proportionally', () => {
    seedAccountsVaried(ledger, [6000, 4000]);
    ledger.recordTrade(mockTrade({ profit_loss: -500 }));

    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    expect(a1.current_balance).toBe(5700); // 6000 - 300
    expect(a2.current_balance).toBe(3800); // 4000 - 200
  });

  it('should handle single account getting full P&L', () => {
    seedAccounts(ledger, 1, 10000);
    ledger.recordTrade(mockTrade({ profit_loss: 500 }));
    expect(ledger.getNFTAccount(1)!.current_balance).toBe(10500);
  });

  it('should update total_pnl correctly', () => {
    seedAccounts(ledger, 1, 10000);
    ledger.recordTrade(mockTrade({ profit_loss: 500 }));
    expect(ledger.getNFTAccount(1)!.total_pnl).toBe(500);
  });

  it('should update fund_state pool after trade', () => {
    seedAccounts(ledger, 3, 5000);
    ledger.recordTrade(mockTrade({ profit_loss: 900 }));
    expect(ledger.getFundState().total_pool_balance).toBe(15900);
  });

  it('should record trade allocations with snapshots', () => {
    seedAccountsVaried(ledger, [7000, 3000]);
    const trade = ledger.recordTrade(mockTrade({ profit_loss: 1000 }));

    const allocs = ledger.getTradeAllocations(trade.id!);
    expect(allocs).toHaveLength(2);

    const a1Alloc = allocs.find(a => a.token_id === 1)!;
    expect(a1Alloc.balance_at_trade).toBe(7000);
    expect(a1Alloc.pool_total_at_trade).toBe(10000);
  });

  it('should handle sequential trades correctly', () => {
    seedAccounts(ledger, 2, 5000); // 5000 each, 10000 total
    ledger.recordTrade(mockTrade({ profit_loss: 1000 })); // each gets +500 → 5500 each, 11000 total
    ledger.recordTrade(mockTrade({ profit_loss: -550 })); // each gets -275 → 5225 each, 10450 total

    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    expect(a1.current_balance).toBe(5225);
    expect(a2.current_balance).toBe(5225);
    expect(ledger.getFundState().total_pool_balance).toBe(10450);
  });

  it('should handle zero profit_loss without creating allocations', () => {
    seedAccounts(ledger, 2, 5000);
    ledger.recordTrade(mockTrade({ profit_loss: 0 }));

    const trade = ledger.getTradeHistory(1)[0];
    const allocs = ledger.getTradeAllocations(trade.id!);
    expect(allocs).toHaveLength(0);
    expect(ledger.getNFTAccount(1)!.current_balance).toBe(5000);
  });

  it('should distribute to all accounts correctly', () => {
    const maxNfts = Number(process.env.MAX_NFTS) || 20;
    seedAccounts(ledger, maxNfts, 5000);
    const trade = ledger.recordTrade(mockTrade({ profit_loss: 10000 }));

    // 10000 / maxNfts = 500 each, no remainder
    for (let i = 1; i <= maxNfts; i++) {
      expect(ledger.getNFTAccount(i)!.current_balance).toBe(5500);
    }
    expect(ledger.getFundState().total_pool_balance).toBe(maxNfts * 5000 + 10000);
  });

  it('should handle profit with varied balances (3 accounts)', () => {
    seedAccountsVaried(ledger, [10000, 5000, 5000]); // 50/25/25
    ledger.recordTrade(mockTrade({ profit_loss: 1000 }));

    expect(ledger.getNFTAccount(1)!.current_balance).toBe(10500);
    expect(ledger.getNFTAccount(2)!.current_balance).toBe(5250);
    expect(ledger.getNFTAccount(3)!.current_balance).toBe(5250);
  });
});

// ── Remainder Correction ──────────────────────────────────────

describe('Remainder Correction', () => {
  it('should distribute remainder for profit (3 accounts, indivisible)', () => {
    seedAccountsVaried(ledger, [5000, 3000, 2000]); // total 10000
    // profit 100: shares = trunc(50), trunc(30), trunc(20) = 100, remainder = 0
    // But let's do 7: shares = trunc(3.5)=3, trunc(2.1)=2, trunc(1.4)=1 = 6, remainder = 1
    ledger.recordTrade(mockTrade({ profit_loss: 7 }));

    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    const a3 = ledger.getNFTAccount(3)!;

    // Remainder 1 goes to token 1 (highest balance)
    expect(a1.current_balance).toBe(5004); // 5000 + 3 + 1
    expect(a2.current_balance).toBe(3002); // 3000 + 2
    expect(a3.current_balance).toBe(2001); // 2000 + 1

    // Sum must equal pool
    expect(a1.current_balance + a2.current_balance + a3.current_balance).toBe(10007);
  });

  it('should distribute remainder for loss', () => {
    seedAccountsVaried(ledger, [5000, 3000, 2000]);
    // loss -7: shares = trunc(-3.5)=-3, trunc(-2.1)=-2, trunc(-1.4)=-1 = -6, remainder = -1
    ledger.recordTrade(mockTrade({ profit_loss: -7 }));

    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    const a3 = ledger.getNFTAccount(3)!;

    // Remainder -1 goes to token 1 (highest balance, direction = -1)
    expect(a1.current_balance).toBe(4996); // 5000 - 3 - 1
    expect(a2.current_balance).toBe(2998); // 3000 - 2
    expect(a3.current_balance).toBe(1999); // 2000 - 1
  });

  it('should be deterministic (tie-break by token_id)', () => {
    seedAccountsVaried(ledger, [5000, 5000]); // equal balances
    // profit 3: shares = trunc(1.5)=1, trunc(1.5)=1 = 2, remainder = 1
    ledger.recordTrade(mockTrade({ profit_loss: 3 }));

    // Tie-break: token 1 gets remainder (lower token_id comes first in sort)
    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    expect(a1.current_balance).toBe(5002); // 5000 + 1 + 1
    expect(a2.current_balance).toBe(5001); // 5000 + 1
  });
});

// ── Withdrawal ────────────────────────────────────────────────

describe('Withdrawal', () => {
  it('should calculate 2% fee correctly', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 10000);
    const w = ledger.recordWithdrawal(1, 'dest_addr', 'tx_w1');
    expect(w.amount).toBe(10000);
    expect(w.fee).toBe(200); // 2% of 10000
    expect(w.net_amount).toBe(9800);
  });

  it('should soft-delete the account', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 10000);
    ledger.recordWithdrawal(1, 'dest_addr', 'tx_w1');
    const acct = ledger.getNFTAccount(1)!;
    expect(acct.is_active).toBe(0);
    expect(acct.current_balance).toBe(0);
  });

  it('should remove account from pool balance and count', () => {
    seedAccounts(ledger, 3, 5000);
    ledger.recordWithdrawal(2, 'dest', 'tx_w');
    const state = ledger.getFundState();
    // 15000 - 5000 (withdrawn) + 100 (fee distributed back) = 10100
    expect(state.total_pool_balance).toBe(10100);
    expect(state.total_nfts_active).toBe(2);
  });

  it('should distribute fee to remaining holders', () => {
    seedAccountsVaried(ledger, [5000, 5000, 10000]);
    // Withdraw account 3 (balance 10000), fee = 200
    ledger.recordWithdrawal(3, 'dest', 'tx_w');

    // Remaining pool before fee distribution: 10000 (5000+5000)
    // Fee 200 split 50/50 → each gets 100
    const a1 = ledger.getNFTAccount(1)!;
    const a2 = ledger.getNFTAccount(2)!;
    expect(a1.current_balance).toBe(5100);
    expect(a2.current_balance).toBe(5100);
  });

  it('should reject withdrawal from inactive account', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.recordWithdrawal(1, 'dest', 'tx_w1');
    expect(() => ledger.recordWithdrawal(1, 'dest', 'tx_w2')).toThrow(AccountNotFoundError);
  });

  it('should maintain invariants after withdrawal', () => {
    seedAccounts(ledger, 5, 10000);
    ledger.recordWithdrawal(3, 'dest', 'tx_w');
    // If we got here, invariants passed inside the transaction
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });

  it('should handle withdrawal when only one account remains', () => {
    seedAccounts(ledger, 2, 5000);
    ledger.recordWithdrawal(1, 'dest', 'tx_w1');
    // Fee from acct 1 (100 cents) goes to acct 2
    const a2 = ledger.getNFTAccount(2)!;
    expect(a2.current_balance).toBe(5100);
    expect(ledger.getFundState().total_pool_balance).toBe(5100);
  });
});

// ── P2P Sale ──────────────────────────────────────────────────

describe('P2P Sale', () => {
  it('should transfer ownership without changing balance', () => {
    ledger.createNFTAccount(1, 'tg_seller', 'addr_seller', 8000);
    ledger.recordP2PSale(1, 'tg_buyer', 'addr_buyer', 10000, 'tx_sale');

    const acct = ledger.getNFTAccount(1)!;
    expect(acct.owner_telegram_id).toBe('tg_buyer');
    expect(acct.owner_address).toBe('addr_buyer');
    expect(acct.current_balance).toBe(8000); // unchanged
  });

  it('should not change pool balance', () => {
    seedAccounts(ledger, 3, 5000);
    const poolBefore = ledger.getFundState().total_pool_balance;
    ledger.recordP2PSale(2, 'tg_buyer', 'addr_buyer', 7000, 'tx_sale');
    expect(ledger.getFundState().total_pool_balance).toBe(poolBefore);
  });

  it('should record the sale with seller info', () => {
    ledger.createNFTAccount(1, 'tg_seller', 'addr_seller', 8000);
    const sale = ledger.recordP2PSale(1, 'tg_buyer', 'addr_buyer', 10000, 'tx_sale');
    expect(sale.seller_telegram_id).toBe('tg_seller');
    expect(sale.buyer_telegram_id).toBe('tg_buyer');
    expect(sale.sale_price).toBe(10000);
  });

  it('should mark active listings as sold', () => {
    ledger.createNFTAccount(1, 'tg_seller', 'addr_seller', 8000);
    ledger.createP2PListing(1, 9000);
    const listings = ledger.getActiveListings();
    expect(listings).toHaveLength(1);

    ledger.recordP2PSale(1, 'tg_buyer', 'addr_buyer', 10000, 'tx_sale');
    expect(ledger.getActiveListings()).toHaveLength(0);
  });

  it('should maintain invariants after P2P sale', () => {
    seedAccounts(ledger, 3, 5000);
    ledger.recordP2PSale(2, 'tg_buyer', 'addr_buyer', 7000, 'tx_sale');
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });
});

// ── Invariant Verification ────────────────────────────────────

describe('Invariant Verification', () => {
  it('should pass on clean state', () => {
    seedAccounts(ledger, 5, 5000);
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });

  it('should pass after multiple trades', () => {
    seedAccountsVaried(ledger, [10000, 5000, 3000]);
    ledger.recordTrade(mockTrade({ profit_loss: 500 }));
    ledger.recordTrade(mockTrade({ profit_loss: -200 }));
    ledger.recordTrade(mockTrade({ profit_loss: 1337 }));
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });

  it('should catch pool balance corruption', () => {
    seedAccounts(ledger, 3, 5000);
    // Corrupt fund_state directly
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 99999 WHERE id = 1`).run();
    expect(() => ledger.verifyInvariants()).toThrow(InvariantViolationError);
  });

  it('should catch account balance corruption', () => {
    seedAccounts(ledger, 2, 5000);
    // Corrupt an account's current_balance
    ledger.db.prepare(`UPDATE nft_accounts SET current_balance = 9999 WHERE token_id = 1`).run();
    // Also fix fund_state to dodge invariant 1
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 14999 WHERE id = 1`).run();
    expect(() => ledger.verifyInvariants()).toThrow(InvariantViolationError);
  });

  it('should pause the fund on invariant violation', () => {
    seedAccounts(ledger, 2, 5000);
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 99999 WHERE id = 1`).run();
    try { ledger.verifyInvariants(); } catch { /* expected */ }
    expect(ledger.getFundState().is_paused).toBe(1);
  });

  it('should block operations when paused', () => {
    ledger.createNFTAccount(1, 'tg_1', 'addr_1', 5000);
    ledger.db.prepare(`UPDATE fund_state SET is_paused = 1 WHERE id = 1`).run();
    expect(() => ledger.createNFTAccount(2, 'tg_2', 'addr_2', 5000)).toThrow(FundPausedError);
    expect(() => ledger.recordTrade(mockTrade())).toThrow(FundPausedError);
    expect(() => ledger.recordWithdrawal(1, 'addr', 'tx')).toThrow(FundPausedError);
  });
});

// ── Transaction Atomicity ─────────────────────────────────────

describe('Transaction Atomicity', () => {
  it('should roll back account creation on invariant failure', () => {
    seedAccounts(ledger, 2, 5000);
    // Corrupt state to make next invariant check fail
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 10000 WHERE id = 1`).run();
    // Force is_paused=0 so the guard passes but invariant will fail
    ledger.db.prepare(`UPDATE fund_state SET is_paused = 0 WHERE id = 1`).run();

    // Creating account 3 will add to pool, making it 15000 but sum will be 15000.
    // Actually the invariant check runs INSIDE the transaction after the insert,
    // so let's set it up differently:
    // We need the invariant to fail. Let's manually break account 1's balance.
    ledger.db.prepare(`UPDATE nft_accounts SET current_balance = 9999 WHERE token_id = 1`).run();
    // Fix pool balance to match current state so invariant 1 passes
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 14999 WHERE id = 1`).run();

    // Invariant 2 will fail (current_balance !== initial_deposit + total_pnl)
    // But creating account 3 adds 5000 to pool → 19999, sum would be 9999+5000+5000=19999 ✓
    // Invariant 2 still fails for account 1: 9999 !== 5000 + 0
    expect(() => ledger.createNFTAccount(3, 'tg_3', 'addr_3', 5000)).toThrow(InvariantViolationError);

    // Account 3 should not exist (rolled back)
    expect(ledger.getNFTAccount(3)).toBeNull();
  });

  it('should roll back trade on invariant failure', () => {
    seedAccounts(ledger, 2, 5000);

    // Corrupt account 1 balance to make invariant 2 fail
    ledger.db.prepare(`UPDATE nft_accounts SET current_balance = 4000 WHERE token_id = 1`).run();
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 9000 WHERE id = 1`).run();

    expect(() => ledger.recordTrade(mockTrade({ profit_loss: 100 }))).toThrow(InvariantViolationError);

    // No trades should be recorded
    expect(ledger.getTradeHistory()).toHaveLength(0);
  });

  it('should not leave partial writes on withdrawal failure', () => {
    seedAccounts(ledger, 3, 5000);

    // Corrupt account 2 to make invariant 2 fail during withdrawal
    ledger.db.prepare(`UPDATE nft_accounts SET current_balance = 4000 WHERE token_id = 2`).run();
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 14000 WHERE id = 1`).run();

    expect(() => ledger.recordWithdrawal(1, 'addr', 'tx')).toThrow(InvariantViolationError);

    // Account 1 should still be active (not soft-deleted)
    expect(ledger.getNFTAccount(1)!.is_active).toBe(1);
  });

  it('should roll back P2P sale on failure', () => {
    seedAccounts(ledger, 2, 5000);

    // Corrupt to trigger invariant failure
    ledger.db.prepare(`UPDATE nft_accounts SET current_balance = 4000 WHERE token_id = 2`).run();
    ledger.db.prepare(`UPDATE fund_state SET total_pool_balance = 9000 WHERE id = 1`).run();

    expect(() => ledger.recordP2PSale(1, 'tg_buyer', 'addr_buyer', 7000, 'tx')).toThrow(InvariantViolationError);

    // Ownership should not have changed
    expect(ledger.getNFTAccount(1)!.owner_telegram_id).toBe('tg_1');
  });
});

// ── Stress Tests ──────────────────────────────────────────────

describe('Stress Tests', () => {
  it('should handle max accounts + 1000 trades', () => {
    const maxNfts = Number(process.env.MAX_NFTS) || 20;
    seedAccounts(ledger, maxNfts, 5000);
    const initialPool = maxNfts * 5000;

    for (let i = 0; i < 1000; i++) {
      const pnl = (i % 2 === 0) ? 500 : -300;
      ledger.recordTrade(mockTrade({
        profit_loss: pnl,
        signature: `sig_stress_${i}`,
      }));
    }

    // Net P&L: 500 trades * 500 + 500 trades * -300 = 250000 - 150000 = 100000
    expect(ledger.getFundState().total_pool_balance).toBe(initialPool + 100000);
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });

  it('should handle mixed operations maintaining invariants', () => {
    seedAccounts(ledger, 10, 10000);

    // Some trades
    ledger.recordTrade(mockTrade({ profit_loss: 5000, signature: 'sig_m1' }));
    ledger.recordTrade(mockTrade({ profit_loss: -2000, signature: 'sig_m2' }));

    // Add funds to account 5
    ledger.addFundsToNFT(5, 5000, 'tx_add_mixed');

    // Another trade
    ledger.recordTrade(mockTrade({ profit_loss: 1000, signature: 'sig_m3' }));

    // Withdraw account 3
    ledger.recordWithdrawal(3, 'dest', 'tx_w_mixed');

    // P2P sale on account 7
    ledger.recordP2PSale(7, 'tg_newowner', 'addr_new', 15000, 'tx_p2p_mixed');

    // More trades
    ledger.recordTrade(mockTrade({ profit_loss: 800, signature: 'sig_m4' }));

    expect(() => ledger.verifyInvariants()).not.toThrow();
    expect(ledger.getFundState().total_nfts_active).toBe(9);
  });

  it('should handle large values without overflow', () => {
    // Max safe integer for cents: ~$90 trillion at integer precision
    const largeDep = 1_000_000_00; // $1,000,000.00 = 100M cents
    ledger.createNFTAccount(1, 'tg_whale', 'addr_whale', largeDep);
    ledger.recordTrade(mockTrade({
      profit_loss: 50_000_00, // $50,000 profit
      signature: 'sig_large',
    }));

    expect(ledger.getNFTAccount(1)!.current_balance).toBe(largeDep + 50_000_00);
    expect(() => ledger.verifyInvariants()).not.toThrow();
  });

  it('should survive rapid sequential withdrawals', () => {
    seedAccounts(ledger, 10, 10000);

    // Withdraw 8 accounts, leaving 2
    for (let i = 1; i <= 8; i++) {
      ledger.recordWithdrawal(i, `dest_${i}`, `tx_w_${i}`);
    }

    expect(ledger.getFundState().total_nfts_active).toBe(2);
    expect(() => ledger.verifyInvariants()).not.toThrow();

    // Remaining accounts should have accumulated all the fees
    const a9 = ledger.getNFTAccount(9)!;
    const a10 = ledger.getNFTAccount(10)!;
    expect(a9.current_balance + a10.current_balance).toBe(ledger.getFundState().total_pool_balance);
  });
});
