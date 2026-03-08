import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';
import {
  createListing,
  cancelListing,
  executePurchase,
  getMarketplaceView,
  previewWithdrawal,
  proposeSwap,
  acceptSwap,
  rejectSwap,
  cancelSwap,
  getSwapRequestsView,
} from '../../src/marketplace/marketplace.js';

describe('P2P Marketplace', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
    // Create test accounts
    db.createNFTAccount(1, 'seller_tg', 'seller_addr', 50000);  // $500
    db.createNFTAccount(2, 'alice_tg', 'alice_addr', 30000);    // $300
    db.createNFTAccount(3, 'bob_tg', 'bob_addr', 20000);        // $200
    // Total pool: $1000
  });

  describe('createListing', () => {
    it('creates a listing for owned NFT', () => {
      const result = createListing(db, 1, 'seller_tg', 60000);
      expect(result.success).toBe(true);
      expect(result.listing).toBeDefined();
      expect(result.listing!.token_id).toBe(1);
      expect(result.listing!.asking_price).toBe(60000);
      expect(result.listing!.status).toBe('active');
    });

    it('rejects listing for NFT you do not own', () => {
      const result = createListing(db, 1, 'not_owner', 60000);
      expect(result.success).toBe(false);
      expect(result.error).toContain("don't own");
    });

    it('rejects listing for non-existent NFT', () => {
      const result = createListing(db, 999, 'seller_tg', 60000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not exist');
    });

    it('rejects duplicate active listing', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const result = createListing(db, 1, 'seller_tg', 70000);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already has an active listing');
    });

    it('rejects zero or negative price', () => {
      const result = createListing(db, 1, 'seller_tg', 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });
  });

  describe('cancelListing', () => {
    it('cancels own listing', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const listings = db.getActiveListings();
      const result = cancelListing(db, listings[0].id, 'seller_tg');
      expect(result.success).toBe(true);
      expect(db.getActiveListings().length).toBe(0);
    });

    it('rejects cancellation by non-owner', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const listings = db.getActiveListings();
      const result = cancelListing(db, listings[0].id, 'alice_tg');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Only the seller');
    });

    it('rejects cancellation of non-existent listing', () => {
      const result = cancelListing(db, 9999, 'seller_tg');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('executePurchase', () => {
    it('executes a P2P purchase', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const listings = db.getActiveListings();

      const result = executePurchase(db, listings[0].id, 'buyer_tg', 'buyer_addr', 'tx_sig_123');
      expect(result.success).toBe(true);
      expect(result.sale).toBeDefined();
      expect(result.transferredBalance).toBe(50000); // $500

      // Verify ownership transferred
      const account = db.getNFTAccount(1)!;
      expect(account.owner_telegram_id).toBe('buyer_tg');
      expect(account.owner_address).toBe('buyer_addr');

      // Balance stays the same (pool balance unchanged)
      expect(account.current_balance).toBe(50000);

      // Listing should be marked as sold
      expect(db.getActiveListings().length).toBe(0);
    });

    it('prevents buying own NFT', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const listings = db.getActiveListings();

      const result = executePurchase(db, listings[0].id, 'seller_tg', 'seller_addr', 'tx_sig');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot buy your own');
    });

    it('rejects purchase of non-existent listing', () => {
      const result = executePurchase(db, 9999, 'buyer_tg', 'buyer_addr', 'tx_sig');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('invariants pass after P2P sale', () => {
      createListing(db, 1, 'seller_tg', 60000);
      const listings = db.getActiveListings();
      executePurchase(db, listings[0].id, 'buyer_tg', 'buyer_addr', 'tx_sig');

      expect(() => db.verifyInvariants()).not.toThrow();
    });
  });

  describe('getMarketplaceView', () => {
    it('returns empty when no listings', () => {
      const view = getMarketplaceView(db);
      expect(view.totalListings).toBe(0);
      expect(view.listings).toHaveLength(0);
    });

    it('returns listings with enriched details', () => {
      createListing(db, 1, 'seller_tg', 40000); // Listed at $400 for $500 balance

      const view = getMarketplaceView(db);
      expect(view.totalListings).toBe(1);
      expect(view.listings[0].account.token_id).toBe(1);
      expect(view.listings[0].valueRatio).toBeCloseTo(1.25, 1); // 50000/40000
    });
  });
});

describe('Withdrawals', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
    db.createNFTAccount(1, 'tg_1', 'addr_1', 50000);  // $500
    db.createNFTAccount(2, 'tg_2', 'addr_2', 30000);  // $300
    db.createNFTAccount(3, 'tg_3', 'addr_3', 20000);  // $200
  });

  describe('previewWithdrawal', () => {
    it('calculates correct fee and payout', () => {
      const preview = previewWithdrawal(db, 1);
      expect('error' in preview).toBe(false);
      if ('error' in preview) return;

      expect(preview.grossAmountCents).toBe(50000);
      expect(preview.feeCents).toBe(1000); // 2% of 50000
      expect(preview.netAmountCents).toBe(49000); // 50000 - 1000
      expect(preview.feePct).toBe(2);
      expect(preview.recipientCount).toBe(2); // 2 other active accounts
    });

    it('errors for non-existent NFT', () => {
      const preview = previewWithdrawal(db, 999);
      expect('error' in preview).toBe(true);
    });
  });

  describe('recordWithdrawal (full flow)', () => {
    it('withdraws, burns NFT, distributes fee', () => {
      const withdrawal = db.recordWithdrawal(1, 'dest_addr_1', 'tx_sig_wd');

      expect(withdrawal.amount).toBe(50000);
      expect(withdrawal.fee).toBe(1000);
      expect(withdrawal.net_amount).toBe(49000);

      // NFT should be deactivated
      const account = db.getNFTAccount(1)!;
      expect(account.is_active).toBe(0);
      expect(account.current_balance).toBe(0);

      // Pool should decrease by full balance (fee redistributed back)
      const state = db.getFundState();
      // Original pool: 100000. Removed 50000, added back fee 1000 = 51000
      expect(state.total_pool_balance).toBe(51000);
      expect(state.total_nfts_active).toBe(2);

      // Fee should be distributed to remaining holders
      const acct2 = db.getNFTAccount(2)!;
      const acct3 = db.getNFTAccount(3)!;
      // 1000 fee distributed: acct2 gets 30000/50000 * 1000 = 600, acct3 gets 400
      expect(acct2.current_balance).toBe(30600);
      expect(acct3.current_balance).toBe(20400);

      // Invariants should pass
      expect(() => db.verifyInvariants()).not.toThrow();
    });

    it('handles last account withdrawal', () => {
      // Withdraw accounts 2 and 3 first
      db.recordWithdrawal(2, 'addr_2', 'tx_2');
      db.recordWithdrawal(3, 'addr_3', 'tx_3');

      // Now account 1 is the last one — fee goes nowhere (no remaining holders)
      const withdrawal = db.recordWithdrawal(1, 'addr_1', 'tx_1');
      expect(withdrawal.net_amount).toBeLessThan(withdrawal.amount);

      const state = db.getFundState();
      expect(state.total_nfts_active).toBe(0);
      expect(state.total_pool_balance).toBe(0);
    });
  });
});

describe('Barter / Swaps', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
    db.createNFTAccount(1, 'alice_tg', 'alice_addr', 45000);  // $450
    db.createNFTAccount(2, 'bob_tg', 'bob_addr', 38000);      // $380
    db.createNFTAccount(3, 'charlie_tg', 'charlie_addr', 20000); // $200
    // Total pool: $1030
  });

  it('creates a swap request between two holders', () => {
    const result = proposeSwap(db, 1, 'alice_tg', 2);
    expect(result.success).toBe(true);
    expect(result.swap).toBeDefined();
    expect(result.swap!.proposer_token_id).toBe(1);
    expect(result.swap!.target_token_id).toBe(2);
    expect(result.swap!.proposer_telegram_id).toBe('alice_tg');
    expect(result.swap!.target_telegram_id).toBe('bob_tg');
    expect(result.swap!.status).toBe('pending');
  });

  it('target accepts swap — ownership atomically exchanged', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('bob_tg');
    const swapId = swaps[0].id;

    const result = acceptSwap(db, swapId, 'bob_tg', 'bob_addr');
    expect(result.success).toBe(true);
    expect(result.swap!.status).toBe('accepted');

    // Verify ownership exchanged
    const acct1 = db.getNFTAccount(1)!;
    expect(acct1.owner_telegram_id).toBe('bob_tg');
    expect(acct1.owner_address).toBe('bob_addr');

    const acct2 = db.getNFTAccount(2)!;
    expect(acct2.owner_telegram_id).toBe('alice_tg');
    expect(acct2.owner_address).toBe('alice_addr');
  });

  it('balances unchanged after swap (only ownership changes)', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('bob_tg');
    acceptSwap(db, swaps[0].id, 'bob_tg', 'bob_addr');

    // Balances stay with their NFTs
    const acct1 = db.getNFTAccount(1)!;
    expect(acct1.current_balance).toBe(45000); // Still $450

    const acct2 = db.getNFTAccount(2)!;
    expect(acct2.current_balance).toBe(38000); // Still $380

    // Pool unchanged
    const state = db.getFundState();
    expect(state.total_pool_balance).toBe(103000);
  });

  it('verifyInvariants passes after swap', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('bob_tg');
    acceptSwap(db, swaps[0].id, 'bob_tg', 'bob_addr');

    expect(() => db.verifyInvariants()).not.toThrow();
  });

  it('rejects swap by non-target fails', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('alice_tg');
    const swapId = swaps[0].id;

    // Charlie tries to accept — not the target
    const result = acceptSwap(db, swapId, 'charlie_tg', 'charlie_addr');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Only the target');
  });

  it('cannot swap non-owned NFT', () => {
    const result = proposeSwap(db, 1, 'bob_tg', 2); // Bob doesn't own NFT #1
    expect(result.success).toBe(false);
    expect(result.error).toContain("don't own");
  });

  it('cannot swap with yourself (same owner for both NFTs)', () => {
    // Give Alice NFT #2 as well
    db.transferNFTOwnership(2, 'alice_tg', 'alice_addr');
    const result = proposeSwap(db, 1, 'alice_tg', 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot swap with yourself');
  });

  it('cannot create duplicate pending swap for same pair', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const result = proposeSwap(db, 1, 'alice_tg', 2);
    expect(result.success).toBe(false);
    expect(result.error).toContain('pending swap already exists');
  });

  it('expired swaps are not executable', () => {
    // Create swap then manually backdate its expiry to ensure it's in the past
    const swap = db.createSwapRequest(1, 'alice_tg', 2, 'bob_tg', 1);
    db.db.prepare(
      `UPDATE p2p_swap_requests SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`
    ).run(swap.id);

    const result = acceptSwap(db, swap.id, 'bob_tg', 'bob_addr');
    expect(result.success).toBe(false);
    expect(result.error).toContain('expired');
  });

  it('cancellation by proposer works', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('alice_tg');
    const swapId = swaps[0].id;

    const result = cancelSwap(db, swapId, 'alice_tg');
    expect(result.success).toBe(true);

    // Swap should no longer be pending
    const swap = db.getSwapRequest(swapId)!;
    expect(swap.status).toBe('cancelled');
  });

  it('cancellation by non-proposer fails', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('bob_tg');
    const swapId = swaps[0].id;

    const result = cancelSwap(db, swapId, 'bob_tg');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Only the proposer');
  });

  it('rejection by target works', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('bob_tg');
    const swapId = swaps[0].id;

    const result = rejectSwap(db, swapId, 'bob_tg');
    expect(result.success).toBe(true);

    const swap = db.getSwapRequest(swapId)!;
    expect(swap.status).toBe('rejected');
  });

  it('rejection by non-target fails', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    const swaps = db.getSwapRequestsForUser('alice_tg');
    const swapId = swaps[0].id;

    const result = rejectSwap(db, swapId, 'alice_tg');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Only the target');
  });

  it('other pending swaps involving swapped NFTs get cancelled on execution', () => {
    // Alice proposes swap: NFT #1 for NFT #2
    proposeSwap(db, 1, 'alice_tg', 2);
    // Alice also proposes swap: NFT #1 for NFT #3
    proposeSwap(db, 1, 'alice_tg', 3);
    // Charlie proposes swap: NFT #3 for NFT #2
    proposeSwap(db, 3, 'charlie_tg', 2);

    // Bob accepts the first swap (#1 for #2)
    const swaps = db.getSwapRequestsForUser('bob_tg');
    const swap12 = swaps.find(s => s.proposer_token_id === 1 && s.target_token_id === 2)!;
    acceptSwap(db, swap12.id, 'bob_tg', 'bob_addr');

    // Other swaps involving NFT #1 or #2 should be cancelled
    const allSwaps = db.getPendingSwapRequests();
    expect(allSwaps.length).toBe(0);
  });

  it('getSwapRequestsView returns pending swaps for user', () => {
    proposeSwap(db, 1, 'alice_tg', 2);
    proposeSwap(db, 3, 'charlie_tg', 2);

    // Bob should see both swaps (target in both)
    const bobView = getSwapRequestsView(db, 'bob_tg');
    expect(bobView.totalSwaps).toBe(2);

    // Alice should see only her swap
    const aliceView = getSwapRequestsView(db, 'alice_tg');
    expect(aliceView.totalSwaps).toBe(1);

    // All pending swaps
    const allView = getSwapRequestsView(db);
    expect(allView.totalSwaps).toBe(2);
  });
});
