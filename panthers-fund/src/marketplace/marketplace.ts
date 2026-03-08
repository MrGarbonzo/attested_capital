/**
 * P2P Marketplace — listing, purchasing, and escrow logic.
 *
 * Key rules:
 * - 0% P2P fee (fund takes nothing)
 * - Fund acts as escrow (buyer sends to fund, fund transfers ownership)
 * - NFT + balance transfer atomically
 * - Seller must own the NFT to list
 * - Only one active listing per NFT
 */
import type { DatabaseLedger } from '../database/ledger.js';
import type { P2PListing, P2PSale, SwapRequest } from '../types/trade.js';
import type { NFTAccount } from '../types/nft-account.js';

// ── Listing Management ─────────────────────────────────────────

export interface ListingResult {
  success: boolean;
  listing?: P2PListing;
  error?: string;
}

/**
 * Create a P2P listing for an NFT.
 * Validates ownership and ensures no duplicate active listings.
 */
export function createListing(
  db: DatabaseLedger,
  tokenId: number,
  sellerTelegramId: string,
  askingPriceCents: number,
): ListingResult {
  // Verify the NFT exists and is active
  const account = db.getNFTAccount(tokenId);
  if (!account) {
    return { success: false, error: `NFT #${tokenId} does not exist` };
  }
  if (!account.is_active) {
    return { success: false, error: `NFT #${tokenId} is not active (withdrawn)` };
  }

  // Verify seller owns this NFT
  if (account.owner_telegram_id !== sellerTelegramId) {
    return { success: false, error: `You don't own NFT #${tokenId}` };
  }

  // Check for existing active listing
  const existingListings = db.getActiveListings();
  const existing = existingListings.find((l) => l.token_id === tokenId);
  if (existing) {
    return { success: false, error: `NFT #${tokenId} already has an active listing (id=${existing.id})` };
  }

  // Validate price
  if (askingPriceCents <= 0) {
    return { success: false, error: 'Asking price must be positive' };
  }

  const listing = db.createP2PListing(tokenId, askingPriceCents);
  return { success: true, listing };
}

/**
 * Cancel a P2P listing.
 * Only the seller can cancel their own listing.
 */
export function cancelListing(
  db: DatabaseLedger,
  listingId: number,
  sellerTelegramId: string,
): { success: boolean; error?: string } {
  const listings = db.getActiveListings();
  const listing = listings.find((l) => l.id === listingId);

  if (!listing) {
    return { success: false, error: `Listing #${listingId} not found or not active` };
  }

  if (listing.seller_telegram_id !== sellerTelegramId) {
    return { success: false, error: 'Only the seller can cancel their listing' };
  }

  db.cancelP2PListing(listingId);
  return { success: true };
}

// ── Purchase Flow ──────────────────────────────────────────────

export interface PurchaseResult {
  success: boolean;
  sale?: P2PSale;
  error?: string;
  transferredBalance?: number; // cents
}

/**
 * Execute a P2P purchase.
 *
 * Flow:
 * 1. Verify listing is active
 * 2. Verify buyer is not the seller
 * 3. Verify payment (tx_signature proves buyer sent funds to fund wallet)
 * 4. Transfer NFT ownership + balance atomically
 * 5. Mark listing as sold
 *
 * The actual payment is between buyer and seller off-chain (or on-chain
 * with the tx_signature as proof). The fund only transfers the NFT
 * ownership in its database.
 */
export function executePurchase(
  db: DatabaseLedger,
  listingId: number,
  buyerTelegramId: string,
  buyerAddress: string,
  txSignature: string,
): PurchaseResult {
  const listings = db.getActiveListings();
  const listing = listings.find((l) => l.id === listingId);

  if (!listing) {
    return { success: false, error: `Listing #${listingId} not found or not active` };
  }

  // Verify buyer is not the seller
  if (listing.seller_telegram_id === buyerTelegramId) {
    return { success: false, error: 'Cannot buy your own NFT' };
  }

  // Verify the NFT is still active
  const account = db.getNFTAccount(listing.token_id);
  if (!account || !account.is_active) {
    return { success: false, error: `NFT #${listing.token_id} is no longer active` };
  }

  // Execute the P2P sale (atomically transfers ownership + marks listing as sold)
  const sale = db.recordP2PSale(
    listing.token_id,
    buyerTelegramId,
    buyerAddress,
    listing.asking_price,
    txSignature,
  );

  return {
    success: true,
    sale,
    transferredBalance: account.current_balance,
  };
}

// ── Marketplace Views ──────────────────────────────────────────

export interface MarketplaceView {
  listings: ListingWithDetails[];
  totalListings: number;
}

export interface ListingWithDetails {
  listing: P2PListing;
  account: NFTAccount;
  /** Value-to-price ratio: current_balance / asking_price. >1 = bargain. */
  valueRatio: number;
}

/**
 * Get all active listings with enriched details.
 */
export function getMarketplaceView(db: DatabaseLedger): MarketplaceView {
  const listings = db.getActiveListings();
  const enriched: ListingWithDetails[] = [];

  for (const listing of listings) {
    const account = db.getNFTAccount(listing.token_id);
    if (!account || !account.is_active) continue;

    enriched.push({
      listing,
      account,
      valueRatio: listing.asking_price > 0
        ? Math.round((account.current_balance / listing.asking_price) * 100) / 100
        : 0,
    });
  }

  return {
    listings: enriched,
    totalListings: enriched.length,
  };
}

// ── Withdrawal Preview ─────────────────────────────────────────

export interface WithdrawalPreview {
  tokenId: number;
  grossAmountCents: number;
  feeCents: number;
  feePct: number;
  netAmountCents: number;
  recipientCount: number; // how many holders get the fee
}

/**
 * Preview what a withdrawal would look like (without executing it).
 * All-or-nothing: the entire balance is withdrawn.
 */
export function previewWithdrawal(db: DatabaseLedger, tokenId: number): WithdrawalPreview | { error: string } {
  const account = db.getNFTAccount(tokenId);
  if (!account) return { error: `NFT #${tokenId} does not exist` };
  if (!account.is_active) return { error: `NFT #${tokenId} is not active` };
  if (account.current_balance <= 0) return { error: `NFT #${tokenId} has zero balance` };

  const feePct = 2;
  const feeCents = Math.trunc(account.current_balance * feePct / 100);
  const netAmountCents = account.current_balance - feeCents;
  const activeAccounts = db.getAllNFTAccounts(true);
  const recipientCount = activeAccounts.length - 1; // Exclude the withdrawing account

  return {
    tokenId,
    grossAmountCents: account.current_balance,
    feeCents,
    feePct,
    netAmountCents,
    recipientCount,
  };
}

// ── Barter / Swaps ──────────────────────────────────────────────

export interface SwapResult {
  success: boolean;
  swap?: SwapRequest;
  error?: string;
}

/**
 * Propose an NFT-for-NFT swap (barter).
 * Proposer offers their NFT in exchange for the target NFT.
 */
export function proposeSwap(
  db: DatabaseLedger,
  proposerTokenId: number,
  proposerTgId: string,
  targetTokenId: number,
): SwapResult {
  // Look up the target NFT to find its owner
  const targetAccount = db.getNFTAccount(targetTokenId);
  if (!targetAccount) {
    return { success: false, error: `NFT #${targetTokenId} does not exist` };
  }
  if (!targetAccount.is_active) {
    return { success: false, error: `NFT #${targetTokenId} is not active` };
  }

  try {
    const swap = db.createSwapRequest(
      proposerTokenId,
      proposerTgId,
      targetTokenId,
      targetAccount.owner_telegram_id,
    );
    return { success: true, swap };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Accept a pending swap request. Only the target can accept.
 */
export function acceptSwap(
  db: DatabaseLedger,
  swapId: number,
  accepterTgId: string,
  accepterAddr: string,
): SwapResult {
  const swap = db.getSwapRequest(swapId);
  if (!swap) {
    return { success: false, error: `Swap #${swapId} not found` };
  }
  if (swap.target_telegram_id !== accepterTgId) {
    return { success: false, error: 'Only the target can accept a swap request' };
  }

  try {
    const result = db.executeSwap(swapId);
    return { success: true, swap: result };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Reject a swap request. Only the target can reject.
 */
export function rejectSwap(
  db: DatabaseLedger,
  swapId: number,
  rejecterTgId: string,
): { success: boolean; error?: string } {
  try {
    db.rejectSwapRequest(swapId, rejecterTgId);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Cancel a swap request. Only the proposer can cancel.
 */
export function cancelSwap(
  db: DatabaseLedger,
  swapId: number,
  cancellerTgId: string,
): { success: boolean; error?: string } {
  try {
    db.cancelSwapRequest(swapId, cancellerTgId);
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}

/**
 * Get swap requests, optionally filtered by user.
 */
export interface SwapViewResult {
  swaps: SwapRequest[];
  totalSwaps: number;
}

export function getSwapRequestsView(
  db: DatabaseLedger,
  telegramId?: string,
): SwapViewResult {
  // Expire any stale requests first
  db.expireOldSwapRequests();

  const swaps = telegramId
    ? db.getSwapRequestsForUser(telegramId)
    : db.getPendingSwapRequests();

  return { swaps, totalSwaps: swaps.length };
}
