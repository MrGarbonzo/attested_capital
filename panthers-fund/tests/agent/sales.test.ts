import { describe, it, expect, beforeEach } from 'vitest';
import { DatabaseLedger } from '../../src/database/ledger.js';
import {
  getBuyerContext,
  evaluateOffer,
  calculateNFTPrice,
} from '../../src/agent/sales.js';

const MAX_NFTS = Number(process.env.MAX_NFTS) || 20;

describe('getBuyerContext', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
  });

  it('returns default context for new buyer with no accounts', () => {
    const ctx = getBuyerContext(db, 'tg_new');
    expect(ctx.isReturningCustomer).toBe(false);
    expect(ctx.currentlyOwnsNFT).toBe(false);
    expect(ctx.currentTokenId).toBeNull();
    expect(ctx.totalMinted).toBe(0);
    expect(ctx.nftsRemaining).toBe(MAX_NFTS);
    expect(ctx.maxSupply).toBe(MAX_NFTS);
    expect(ctx.soldOutPct).toBe(0);
    expect(ctx.scarcityTier).toBe('abundant');
  });

  it('detects current NFT owner', () => {
    db.createNFTAccount(1, 'tg_owner', 'addr_1', 2000);
    const ctx = getBuyerContext(db, 'tg_owner');
    expect(ctx.currentlyOwnsNFT).toBe(true);
    expect(ctx.currentTokenId).toBe(1);
    expect(ctx.isReturningCustomer).toBe(false);
  });

  it('detects returning customer (previously withdrew)', () => {
    db.createNFTAccount(1, 'tg_returner', 'addr_1', 2000);
    db.recordWithdrawal(1, 'dest_addr', 'tx_sig_1');
    const ctx = getBuyerContext(db, 'tg_returner');
    expect(ctx.isReturningCustomer).toBe(true);
    expect(ctx.currentlyOwnsNFT).toBe(false);
    expect(ctx.currentTokenId).toBeNull();
  });

  it('returns abundant tier when <40% sold', () => {
    // 0 out of 20 = 0%
    const ctx = getBuyerContext(db);
    expect(ctx.scarcityTier).toBe('abundant');
  });

  it('returns moderate tier when 40-70% sold', () => {
    // Mint 50% of MAX_NFTS
    const count = Math.ceil(MAX_NFTS * 0.5);
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const ctx = getBuyerContext(db);
    expect(ctx.scarcityTier).toBe('moderate');
  });

  it('returns scarce tier when 70%+ sold', () => {
    // Mint 80% of MAX_NFTS
    const count = Math.ceil(MAX_NFTS * 0.8);
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const ctx = getBuyerContext(db);
    expect(ctx.scarcityTier).toBe('scarce');
  });

  it('returns final_few tier when <=2 remaining', () => {
    // Mint all but 2
    const count = MAX_NFTS - 2;
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const ctx = getBuyerContext(db);
    expect(ctx.scarcityTier).toBe('final_few');
    expect(ctx.nftsRemaining).toBe(2);
  });

  it('sets suggestedMood to firm when final_few', () => {
    const count = MAX_NFTS - 1;
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const ctx = getBuyerContext(db);
    expect(ctx.suggestedMood).toBe('firm');
  });

  it('returning customers get lower suggestedFloorCents', () => {
    db.createNFTAccount(1, 'tg_ret', 'addr_1', 5000);
    db.recordWithdrawal(1, 'dest_addr', 'tx_sig_1');

    const ctxReturning = getBuyerContext(db, 'tg_ret');
    const ctxNew = getBuyerContext(db, 'tg_new');

    expect(ctxReturning.isReturningCustomer).toBe(true);
    expect(ctxReturning.suggestedFloorCents).toBeLessThan(ctxNew.suggestedFloorCents);
  });

  it('works without telegram ID', () => {
    db.createNFTAccount(1, 'tg_1', 'addr_1', 2000);
    const ctx = getBuyerContext(db);
    expect(ctx.isReturningCustomer).toBe(false);
    expect(ctx.currentlyOwnsNFT).toBe(false);
    expect(ctx.totalMinted).toBe(1);
    expect(ctx.currentPriceCents).toBeGreaterThan(0);
    expect(ctx.negotiationHints).toBeDefined();
  });

  it('adds hint when buyer already owns an NFT', () => {
    db.createNFTAccount(1, 'tg_owner', 'addr_1', 2000);
    const ctx = getBuyerContext(db, 'tg_owner');
    expect(ctx.negotiationHints.some((h) => h.includes("can't buy another"))).toBe(true);
  });
});

describe('evaluateOffer (enhanced)', () => {
  let db: DatabaseLedger;

  beforeEach(() => {
    db = new DatabaseLedger(':memory:');
  });

  it('accepts offer at listed price', () => {
    const pricing = calculateNFTPrice(db);
    const result = evaluateOffer(db, pricing.finalPriceCents);
    expect(result.accepted).toBe(true);
    expect(result.listedPriceCents).toBe(pricing.finalPriceCents);
  });

  it('accepts 14% discount when abundant', () => {
    // 0 minted = abundant, accept threshold = 85%
    const pricing = calculateNFTPrice(db);
    const offer = Math.trunc(pricing.finalPriceCents * 0.86);
    const result = evaluateOffer(db, offer);
    expect(result.accepted).toBe(true);
    expect(result.scarcityTier).toBe('abundant');
  });

  it('rejects 14% discount when scarce', () => {
    // Mint 80% to reach scarce tier
    const count = Math.ceil(MAX_NFTS * 0.8);
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const pricing = calculateNFTPrice(db);
    const offer = Math.trunc(pricing.finalPriceCents * 0.86);
    const result = evaluateOffer(db, offer);
    // scarce accept threshold = 92%, so 86% should NOT be accepted
    expect(result.accepted).toBe(false);
    expect(result.scarcityTier).toBe('scarce');
  });

  it('counter-offers in the negotiation zone', () => {
    const pricing = calculateNFTPrice(db);
    // abundant counter zone: 70-85%
    const offer = Math.trunc(pricing.finalPriceCents * 0.75);
    const result = evaluateOffer(db, offer);
    expect(result.accepted).toBe(false);
    expect(result.counterOfferCents).toBeDefined();
    // Counter = (offer + listed*2) / 3 — should be between offer and listed
    expect(result.counterOfferCents!).toBeGreaterThan(offer);
    expect(result.counterOfferCents!).toBeLessThan(pricing.finalPriceCents);
  });

  it('rejects lowball with hints', () => {
    const pricing = calculateNFTPrice(db);
    const offer = Math.trunc(pricing.finalPriceCents * 0.3);
    const result = evaluateOffer(db, offer);
    expect(result.accepted).toBe(false);
    expect(result.counterOfferCents).toBeUndefined();
    expect(result.responseHints.length).toBeGreaterThan(0);
    expect(result.responseHints.some((h) => h.includes('lowball'))).toBe(true);
  });

  it('gives returning customer leeway', () => {
    db.createNFTAccount(1, 'tg_ret', 'addr_1', 5000);
    db.recordWithdrawal(1, 'dest_addr', 'tx_sig_1');

    const pricing = calculateNFTPrice(db);
    // Abundant accept = 85%, returning leeway = -3% → 82%
    const offer = Math.trunc(pricing.finalPriceCents * 0.83);

    const resultReturning = evaluateOffer(db, offer, 'tg_ret');
    const resultNew = evaluateOffer(db, offer, 'tg_new');

    expect(resultReturning.isReturningCustomer).toBe(true);
    expect(resultReturning.accepted).toBe(true);
    expect(resultNew.accepted).toBe(false);
  });

  it('tightens to 8% max discount for final_few', () => {
    const count = MAX_NFTS - 2;
    for (let i = 1; i <= count; i++) {
      db.createNFTAccount(i, `tg_${i}`, `addr_${i}`, 2000);
    }
    const result = evaluateOffer(db, 100); // lowball
    expect(result.scarcityTier).toBe('final_few');
    expect(result.maxDiscountPct).toBe(8);
  });

  it('works without buyerTelegramId (backward compat)', () => {
    const pricing = calculateNFTPrice(db);
    const result = evaluateOffer(db, pricing.finalPriceCents);
    expect(result.accepted).toBe(true);
    expect(result.listedPriceCents).toBe(pricing.finalPriceCents);
    expect(result.scarcityTier).toBeDefined();
    expect(result.isReturningCustomer).toBe(false);
    expect(result.maxDiscountPct).toBeDefined();
    expect(result.advisoryFloorCents).toBeDefined();
    expect(result.responseHints).toBeDefined();
  });
});
