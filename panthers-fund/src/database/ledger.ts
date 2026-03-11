import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NFTAccount, FundState, FundAddition, StakingState } from '../types/nft-account.js';
import type { Trade, TradeAllocation, Withdrawal, P2PSale, P2PListing, SwapRequest } from '../types/trade.js';
import type { WalletState, BalanceSnapshot } from '../types/wallet.js';
import type { OpenPosition, DailyTradeStats, TradingConfig } from '../strategies/types.js';
import {
  InvariantViolationError,
  FundPausedError,
  AccountNotFoundError,
} from '../types/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class DatabaseLedger {
  readonly db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);

    // Ensure fund_state singleton row exists
    this.db.prepare(
      `INSERT OR IGNORE INTO fund_state (id, total_pool_balance, total_nfts_active) VALUES (1, 0, 0)`
    ).run();

    // Migrate existing DBs that have old multi-chain columns
    this.migrateNFTAccountColumns();

    // Ensure sentiment_log table exists (for older DBs)
    this.migrateSentimentLog();

    // Ensure staking state cache table exists (for older DBs)
    this.migrateStakingState();

    // Ensure backup_agents table exists (for older DBs)
    this.migrateBackupAgents();
  }

  close(): void {
    this.db.close();
  }

  /** Add mint_address column if missing (existing DBs). Drop-safe for old multi-chain columns. */
  private migrateNFTAccountColumns(): void {
    const cols = this.db.pragma('table_info(nft_accounts)') as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('mint_address')) {
      this.db.exec(`ALTER TABLE nft_accounts ADD COLUMN mint_address TEXT`);
    }

    // Migrate wallet_state: handle old schemas with extra columns
    const wCols = this.db.pragma('table_info(wallet_state)') as Array<{ name: string }>;
    const wNames = new Set(wCols.map((c) => c.name));
    // Old DBs may have secret_address, ethereum_address, base_address — they're harmless, just ignored

    // Migrate withdrawals: handle old schemas with dest_chain column
    const wdCols = this.db.pragma('table_info(withdrawals)') as Array<{ name: string }>;
    const wdNames = new Set(wdCols.map((c) => c.name));
    // Old DBs may have dest_chain — harmless, just ignored

    // Ensure nft_collection_config table exists (for older DBs without it)
    // Already handled by schema.sql CREATE TABLE IF NOT EXISTS
  }

  /** Ensure sentiment_log table exists for older DBs created before this migration. */
  private migrateSentimentLog(): void {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='sentiment_log'`
    ).get() as { name: string } | undefined;

    if (!tables) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sentiment_log (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          score           REAL NOT NULL,
          confidence      REAL NOT NULL,
          reasoning       TEXT NOT NULL,
          extreme_event   TEXT,
          twitter_score   REAL,
          telegram_score  REAL,
          news_score      REAL,
          blend_layer     TEXT,
          strategy_action TEXT,
          blended_action  TEXT,
          raw_json        TEXT NOT NULL,
          created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_sentiment_log_time ON sentiment_log(created_at);
      `);
    }
  }

  /** Ensure nft_staking_state table exists for older DBs. */
  private migrateStakingState(): void {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='nft_staking_state'`
    ).get() as { name: string } | undefined;

    if (!tables) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS nft_staking_state (
          token_id          INTEGER PRIMARY KEY,
          owner_tg_id       TEXT NOT NULL,
          guardian_address   TEXT NOT NULL,
          guardian_endpoint  TEXT NOT NULL,
          staked_at         TEXT NOT NULL,
          stake_value_cents INTEGER NOT NULL DEFAULT 0,
          delegated_to      TEXT,
          delegation_expires TEXT,
          synced_at         TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_staking_state_owner ON nft_staking_state(owner_tg_id);
      `);
    }
  }

  /** Ensure backup_agents table exists (with heartbeat_streak) for older DBs. */
  private migrateBackupAgents(): void {
    const tables = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='backup_agents'`
    ).get() as { name: string } | undefined;

    if (!tables) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS backup_agents (
          id              TEXT PRIMARY KEY,
          endpoint        TEXT NOT NULL,
          registered_at   INTEGER NOT NULL,
          last_heartbeat  INTEGER NOT NULL,
          heartbeat_streak INTEGER NOT NULL DEFAULT 0,
          status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale'))
        );
        CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC);
      `);
    } else {
      // Add heartbeat_streak column if missing (older DBs)
      const cols = this.db.prepare(`PRAGMA table_info(backup_agents)`).all() as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'heartbeat_streak')) {
        this.db.exec(`ALTER TABLE backup_agents ADD COLUMN heartbeat_streak INTEGER NOT NULL DEFAULT 0`);
        this.db.exec(`DROP INDEX IF EXISTS idx_backup_agents_registered`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC)`);
      }
    }
  }

  // ── Guards ──────────────────────────────────────────────────

  private guardNotPaused(operation: string): void {
    const state = this.getFundState();
    if (state.is_paused) {
      throw new FundPausedError(operation);
    }
  }

  private guardAccountExists(tokenId: number): NFTAccount {
    const account = this.getNFTAccount(tokenId);
    if (!account) {
      throw new AccountNotFoundError(tokenId);
    }
    return account;
  }

  private guardAccountActive(tokenId: number): NFTAccount {
    const account = this.guardAccountExists(tokenId);
    if (!account.is_active) {
      throw new AccountNotFoundError(tokenId);
    }
    return account;
  }

  // ── Account CRUD ────────────────────────────────────────────

  createNFTAccount(
    tokenId: number,
    ownerTelegramId: string,
    ownerAddress: string,
    depositCents: number,
    opts?: { mintAddress?: string },
  ): NFTAccount {
    this.guardNotPaused('createNFTAccount');

    const maxNfts = Number(process.env.MAX_NFTS) || 20;
    if (tokenId < 1 || tokenId > maxNfts) {
      throw new Error(`token_id must be between 1 and ${maxNfts}, got ${tokenId}`);
    }
    if (depositCents <= 0) {
      throw new Error(`deposit must be positive, got ${depositCents}`);
    }
    if (!Number.isInteger(depositCents)) {
      throw new Error(`deposit must be an integer (cents), got ${depositCents}`);
    }

    return this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO nft_accounts (token_id, owner_telegram_id, owner_address, initial_deposit, current_balance, total_pnl, mint_address)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).run(tokenId, ownerTelegramId, ownerAddress, depositCents, depositCents, opts?.mintAddress ?? null);

      this.db.prepare(
        `UPDATE fund_state SET
           total_pool_balance = total_pool_balance + ?,
           total_nfts_active = total_nfts_active + 1,
           updated_at = datetime('now')
         WHERE id = 1`
      ).run(depositCents);

      this.verifyInvariants();
      return this.getNFTAccount(tokenId)!;
    })();
  }

  getNFTAccount(tokenId: number): NFTAccount | null {
    return (this.db.prepare(
      `SELECT * FROM nft_accounts WHERE token_id = ?`
    ).get(tokenId) as NFTAccount | undefined) ?? null;
  }

  getNFTsByOwner(ownerTelegramId: string): NFTAccount[] {
    return this.db.prepare(
      `SELECT * FROM nft_accounts WHERE owner_telegram_id = ? AND is_active = 1 ORDER BY token_id`
    ).all(ownerTelegramId) as NFTAccount[];
  }

  getAllNFTAccounts(activeOnly: boolean = false): NFTAccount[] {
    if (activeOnly) {
      return this.db.prepare(
        `SELECT * FROM nft_accounts WHERE is_active = 1 ORDER BY token_id`
      ).all() as NFTAccount[];
    }
    return this.db.prepare(
      `SELECT * FROM nft_accounts ORDER BY token_id`
    ).all() as NFTAccount[];
  }

  /** Update the mint_address on an existing NFT account. */
  setMintAddress(tokenId: number, mintAddress: string): void {
    this.db.prepare(
      `UPDATE nft_accounts SET mint_address = ?, updated_at = datetime('now') WHERE token_id = ?`
    ).run(mintAddress, tokenId);
  }

  // ── Add Funds ───────────────────────────────────────────────

  addFundsToNFT(tokenId: number, amountCents: number, txHash: string): FundAddition {
    this.guardNotPaused('addFundsToNFT');

    if (amountCents <= 0) {
      throw new Error(`amount must be positive, got ${amountCents}`);
    }
    if (!Number.isInteger(amountCents)) {
      throw new Error(`amount must be an integer (cents), got ${amountCents}`);
    }

    return this.db.transaction(() => {
      this.guardAccountActive(tokenId);

      this.db.prepare(
        `UPDATE nft_accounts SET
           initial_deposit = initial_deposit + ?,
           current_balance = current_balance + ?,
           updated_at = datetime('now')
         WHERE token_id = ?`
      ).run(amountCents, amountCents, tokenId);

      this.db.prepare(
        `UPDATE fund_state SET
           total_pool_balance = total_pool_balance + ?,
           updated_at = datetime('now')
         WHERE id = 1`
      ).run(amountCents);

      this.db.prepare(
        `INSERT INTO fund_additions (token_id, amount, tx_hash) VALUES (?, ?, ?)`
      ).run(tokenId, amountCents, txHash);

      this.verifyInvariants();

      return this.db.prepare(
        `SELECT * FROM fund_additions WHERE token_id = ? ORDER BY id DESC LIMIT 1`
      ).get(tokenId) as FundAddition;
    })();
  }

  // ── Trade Recording & P&L Distribution ──────────────────────

  recordTrade(trade: Omit<Trade, 'id' | 'created_at'>): Trade {
    this.guardNotPaused('recordTrade');

    return this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO trades (strategy, pair, direction, entry_price, exit_price, amount, profit_loss, signature, attestation)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        trade.strategy, trade.pair, trade.direction,
        trade.entry_price, trade.exit_price, trade.amount,
        trade.profit_loss, trade.signature, trade.attestation,
      );

      const tradeId = Number(result.lastInsertRowid);
      this.distributeTradePnL(tradeId, trade.profit_loss);

      this.verifyInvariants();

      return this.db.prepare(
        `SELECT * FROM trades WHERE id = ?`
      ).get(tradeId) as Trade;
    })();
  }

  distributeTradePnL(tradeId: number, profitLossCents: number): void {
    if (profitLossCents === 0) return;

    const accounts = this.getAllNFTAccounts(true);
    if (accounts.length === 0) return;

    const fundState = this.getFundState();
    const totalPool = fundState.total_pool_balance;
    if (totalPool === 0) return;

    // Step 1: Calculate truncated shares
    const shares: { tokenId: number; share: number; balance: number }[] = [];
    let sumShares = 0;

    for (const acct of accounts) {
      const share = Math.trunc((acct.current_balance * profitLossCents) / totalPool);
      shares.push({ tokenId: acct.token_id, share, balance: acct.current_balance });
      sumShares += share;
    }

    // Step 2: Remainder correction
    let remainder = profitLossCents - sumShares;

    // Sort by descending balance, tie-break by token_id ascending
    shares.sort((a, b) => b.balance - a.balance || a.tokenId - b.tokenId);

    // Distribute remainder: +1 for profit, -1 for loss
    const direction = profitLossCents > 0 ? 1 : -1;
    let i = 0;
    while (remainder !== 0) {
      shares[i % shares.length].share += direction;
      remainder -= direction;
      i++;
    }

    // Step 3: Apply allocations
    const insertAlloc = this.db.prepare(
      `INSERT INTO trade_allocations (trade_id, token_id, pnl_share, balance_at_trade, pool_total_at_trade)
       VALUES (?, ?, ?, ?, ?)`
    );
    const updateAccount = this.db.prepare(
      `UPDATE nft_accounts SET
         current_balance = current_balance + ?,
         total_pnl = total_pnl + ?,
         updated_at = datetime('now')
       WHERE token_id = ?`
    );

    for (const s of shares) {
      insertAlloc.run(tradeId, s.tokenId, s.share, s.balance, totalPool);
      updateAccount.run(s.share, s.share, s.tokenId);
    }

    // Update fund_state pool balance
    this.db.prepare(
      `UPDATE fund_state SET
         total_pool_balance = total_pool_balance + ?,
         updated_at = datetime('now')
       WHERE id = 1`
    ).run(profitLossCents);
  }

  // ── Withdrawal ──────────────────────────────────────────────

  recordWithdrawal(
    tokenId: number,
    destAddr: string,
    txSig: string,
  ): Withdrawal {
    this.guardNotPaused('recordWithdrawal');

    return this.db.transaction(() => {
      const account = this.guardAccountActive(tokenId);
      const balance = account.current_balance;
      const fee = Math.trunc(balance * 2 / 100); // 2% fee
      const netAmount = balance - fee;

      // Record withdrawal
      this.db.prepare(
        `INSERT INTO withdrawals (token_id, amount, fee, net_amount, dest_address, tx_signature)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(tokenId, balance, fee, netAmount, destAddr, txSig);

      // Soft-delete: deactivate account, zero out balances
      this.db.prepare(
        `UPDATE nft_accounts SET
           current_balance = 0,
           is_active = 0,
           updated_at = datetime('now')
         WHERE token_id = ?`
      ).run(tokenId);

      // Update fund_state: remove the full balance, decrement count
      this.db.prepare(
        `UPDATE fund_state SET
           total_pool_balance = total_pool_balance - ?,
           total_nfts_active = total_nfts_active - 1,
           updated_at = datetime('now')
         WHERE id = 1`
      ).run(balance);

      // Distribute the fee to remaining active holders
      if (fee > 0) {
        this.distributeWithdrawalFee(fee);
      }

      this.verifyInvariants();

      return this.db.prepare(
        `SELECT * FROM withdrawals WHERE token_id = ? ORDER BY id DESC LIMIT 1`
      ).get(tokenId) as Withdrawal;
    })();
  }

  distributeWithdrawalFee(feeCents: number): void {
    if (feeCents === 0) return;

    const accounts = this.getAllNFTAccounts(true);
    if (accounts.length === 0) return;

    const fundState = this.getFundState();
    const totalPool = fundState.total_pool_balance;
    if (totalPool === 0) return;

    // Same proportional distribution with remainder correction
    const shares: { tokenId: number; share: number; balance: number }[] = [];
    let sumShares = 0;

    for (const acct of accounts) {
      const share = Math.trunc((acct.current_balance * feeCents) / totalPool);
      shares.push({ tokenId: acct.token_id, share, balance: acct.current_balance });
      sumShares += share;
    }

    let remainder = feeCents - sumShares;
    shares.sort((a, b) => b.balance - a.balance || a.tokenId - b.tokenId);

    let i = 0;
    while (remainder > 0) {
      shares[i % shares.length].share += 1;
      remainder -= 1;
      i++;
    }

    const updateAccount = this.db.prepare(
      `UPDATE nft_accounts SET
         current_balance = current_balance + ?,
         total_pnl = total_pnl + ?,
         updated_at = datetime('now')
       WHERE token_id = ?`
    );

    for (const s of shares) {
      if (s.share > 0) {
        updateAccount.run(s.share, s.share, s.tokenId);
      }
    }

    // The fee goes back into the pool
    this.db.prepare(
      `UPDATE fund_state SET
         total_pool_balance = total_pool_balance + ?,
         updated_at = datetime('now')
       WHERE id = 1`
    ).run(feeCents);
  }

  // ── P2P Sale & Transfer ─────────────────────────────────────

  recordP2PSale(
    tokenId: number,
    buyerTgId: string,
    buyerAddr: string,
    salePrice: number,
    txSig: string,
  ): P2PSale {
    this.guardNotPaused('recordP2PSale');

    if (salePrice <= 0) {
      throw new Error(`sale price must be positive, got ${salePrice}`);
    }

    return this.db.transaction(() => {
      const account = this.guardAccountActive(tokenId);
      const sellerTgId = account.owner_telegram_id;

      // Record the sale
      this.db.prepare(
        `INSERT INTO p2p_sales (token_id, seller_telegram_id, buyer_telegram_id, buyer_address, sale_price, tx_signature)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(tokenId, sellerTgId, buyerTgId, buyerAddr, salePrice, txSig);

      // Transfer ownership only — balance stays in the pool
      this.transferNFTOwnership(tokenId, buyerTgId, buyerAddr);

      // Mark any active listings for this token as sold
      this.db.prepare(
        `UPDATE p2p_listings SET status = 'sold', updated_at = datetime('now')
         WHERE token_id = ? AND status = 'active'`
      ).run(tokenId);

      this.verifyInvariants();

      return this.db.prepare(
        `SELECT * FROM p2p_sales WHERE token_id = ? ORDER BY id DESC LIMIT 1`
      ).get(tokenId) as P2PSale;
    })();
  }

  transferNFTOwnership(
    tokenId: number,
    newOwnerTgId: string,
    newOwnerAddr: string,
  ): void {
    this.db.prepare(
      `UPDATE nft_accounts SET
         owner_telegram_id = ?,
         owner_address = ?,
         updated_at = datetime('now')
       WHERE token_id = ?`
    ).run(newOwnerTgId, newOwnerAddr, tokenId);
  }

  // ── P2P Listings ────────────────────────────────────────────

  createP2PListing(tokenId: number, askingPrice: number): P2PListing {
    this.guardNotPaused('createP2PListing');

    if (askingPrice <= 0) {
      throw new Error(`asking price must be positive, got ${askingPrice}`);
    }

    const account = this.guardAccountActive(tokenId);

    this.db.prepare(
      `INSERT INTO p2p_listings (token_id, seller_telegram_id, asking_price)
       VALUES (?, ?, ?)`
    ).run(tokenId, account.owner_telegram_id, askingPrice);

    return this.db.prepare(
      `SELECT * FROM p2p_listings WHERE token_id = ? ORDER BY id DESC LIMIT 1`
    ).get(tokenId) as P2PListing;
  }

  cancelP2PListing(listingId: number): void {
    this.db.prepare(
      `UPDATE p2p_listings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
    ).run(listingId);
  }

  getActiveListings(): P2PListing[] {
    return this.db.prepare(
      `SELECT * FROM p2p_listings WHERE status = 'active' ORDER BY created_at DESC`
    ).all() as P2PListing[];
  }

  // ── P2P Swaps (Barter) ─────────────────────────────────────

  createSwapRequest(
    proposerTokenId: number,
    proposerTgId: string,
    targetTokenId: number,
    targetTgId: string,
    expiresInHours: number = 24,
  ): SwapRequest {
    this.guardNotPaused('createSwapRequest');

    // Both NFTs must be active
    const proposerAcct = this.guardAccountActive(proposerTokenId);
    const targetAcct = this.guardAccountActive(targetTokenId);

    // Ownership must match
    if (proposerAcct.owner_telegram_id !== proposerTgId) {
      throw new Error(`You don't own NFT #${proposerTokenId}`);
    }
    if (targetAcct.owner_telegram_id !== targetTgId) {
      throw new Error(`NFT #${targetTokenId} is not owned by the specified target`);
    }

    // Cannot swap with yourself
    if (proposerTgId === targetTgId) {
      throw new Error('Cannot swap with yourself');
    }

    // No duplicate pending swaps for same pair
    const existing = this.db.prepare(
      `SELECT id FROM p2p_swap_requests
       WHERE status = 'pending'
         AND proposer_token_id = ? AND target_token_id = ?`
    ).get(proposerTokenId, targetTokenId) as { id: number } | undefined;

    if (existing) {
      throw new Error(`A pending swap already exists for NFT #${proposerTokenId} → #${targetTokenId} (swap #${existing.id})`);
    }

    const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
      .toISOString().replace('T', ' ').slice(0, 19);

    this.db.prepare(
      `INSERT INTO p2p_swap_requests (proposer_token_id, proposer_telegram_id, target_token_id, target_telegram_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(proposerTokenId, proposerTgId, targetTokenId, targetTgId, expiresAt);

    return this.db.prepare(
      `SELECT * FROM p2p_swap_requests ORDER BY id DESC LIMIT 1`
    ).get() as SwapRequest;
  }

  getSwapRequest(swapId: number): SwapRequest | null {
    return (this.db.prepare(
      `SELECT * FROM p2p_swap_requests WHERE id = ?`
    ).get(swapId) as SwapRequest | undefined) ?? null;
  }

  getSwapRequestsForUser(telegramId: string): SwapRequest[] {
    return this.db.prepare(
      `SELECT * FROM p2p_swap_requests
       WHERE status = 'pending'
         AND (proposer_telegram_id = ? OR target_telegram_id = ?)
       ORDER BY created_at DESC`
    ).all(telegramId, telegramId) as SwapRequest[];
  }

  getPendingSwapRequests(): SwapRequest[] {
    return this.db.prepare(
      `SELECT * FROM p2p_swap_requests WHERE status = 'pending' ORDER BY created_at DESC`
    ).all() as SwapRequest[];
  }

  executeSwap(swapId: number): SwapRequest {
    this.guardNotPaused('executeSwap');

    return this.db.transaction(() => {
      const swap = this.getSwapRequest(swapId);
      if (!swap) {
        throw new Error(`Swap #${swapId} not found`);
      }
      if (swap.status !== 'pending') {
        throw new Error(`Swap #${swapId} is not pending (status: ${swap.status})`);
      }

      // Check expiry
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
      if (now > swap.expires_at) {
        this.db.prepare(
          `UPDATE p2p_swap_requests SET status = 'expired', updated_at = datetime('now') WHERE id = ?`
        ).run(swapId);
        throw new Error(`Swap #${swapId} has expired`);
      }

      // Both NFTs must still be active and owned by correct parties
      const proposerAcct = this.guardAccountActive(swap.proposer_token_id);
      const targetAcct = this.guardAccountActive(swap.target_token_id);

      if (proposerAcct.owner_telegram_id !== swap.proposer_telegram_id) {
        throw new Error(`NFT #${swap.proposer_token_id} is no longer owned by proposer`);
      }
      if (targetAcct.owner_telegram_id !== swap.target_telegram_id) {
        throw new Error(`NFT #${swap.target_token_id} is no longer owned by target`);
      }

      // Swap ownership: exchange the two owners
      this.transferNFTOwnership(swap.proposer_token_id, swap.target_telegram_id, targetAcct.owner_address);
      this.transferNFTOwnership(swap.target_token_id, swap.proposer_telegram_id, proposerAcct.owner_address);

      // Mark swap as accepted
      this.db.prepare(
        `UPDATE p2p_swap_requests SET status = 'accepted', updated_at = datetime('now') WHERE id = ?`
      ).run(swapId);

      // Cancel any other pending swaps involving either NFT
      this.db.prepare(
        `UPDATE p2p_swap_requests
         SET status = 'cancelled', updated_at = datetime('now')
         WHERE status = 'pending' AND id != ?
           AND (proposer_token_id IN (?, ?) OR target_token_id IN (?, ?))`
      ).run(swapId, swap.proposer_token_id, swap.target_token_id, swap.proposer_token_id, swap.target_token_id);

      this.verifyInvariants();

      return this.getSwapRequest(swapId)!;
    })();
  }

  cancelSwapRequest(swapId: number, telegramId: string): void {
    const swap = this.getSwapRequest(swapId);
    if (!swap) {
      throw new Error(`Swap #${swapId} not found`);
    }
    if (swap.status !== 'pending') {
      throw new Error(`Swap #${swapId} is not pending (status: ${swap.status})`);
    }
    if (swap.proposer_telegram_id !== telegramId) {
      throw new Error('Only the proposer can cancel a swap request');
    }

    this.db.prepare(
      `UPDATE p2p_swap_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`
    ).run(swapId);
  }

  rejectSwapRequest(swapId: number, telegramId: string): void {
    const swap = this.getSwapRequest(swapId);
    if (!swap) {
      throw new Error(`Swap #${swapId} not found`);
    }
    if (swap.status !== 'pending') {
      throw new Error(`Swap #${swapId} is not pending (status: ${swap.status})`);
    }
    if (swap.target_telegram_id !== telegramId) {
      throw new Error('Only the target can reject a swap request');
    }

    this.db.prepare(
      `UPDATE p2p_swap_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`
    ).run(swapId);
  }

  expireOldSwapRequests(): number {
    const result = this.db.prepare(
      `UPDATE p2p_swap_requests
       SET status = 'expired', updated_at = datetime('now')
       WHERE status = 'pending' AND expires_at < datetime('now')`
    ).run();
    return result.changes;
  }

  // ── Invariant Verification ──────────────────────────────────

  verifyInvariants(): void {
    this.verifyInvariant1_PoolBalance();
    this.verifyInvariant2_AccountBalance();
    this.verifyInvariant3_TradeAllocations();
  }

  private verifyInvariant1_PoolBalance(): void {
    const sumResult = this.db.prepare(
      `SELECT COALESCE(SUM(current_balance), 0) AS total FROM nft_accounts WHERE is_active = 1`
    ).get() as { total: number };

    const fundState = this.getFundState();

    if (sumResult.total !== fundState.total_pool_balance) {
      this.pauseFund();
      throw new InvariantViolationError(
        'POOL_BALANCE',
        `SUM(current_balance)=${sumResult.total} !== fund_state.total_pool_balance=${fundState.total_pool_balance}`,
      );
    }
  }

  private verifyInvariant2_AccountBalance(): void {
    const violations = this.db.prepare(
      `SELECT token_id, initial_deposit, current_balance, total_pnl
       FROM nft_accounts
       WHERE is_active = 1
         AND current_balance != initial_deposit + total_pnl`
    ).all() as Pick<NFTAccount, 'token_id' | 'initial_deposit' | 'current_balance' | 'total_pnl'>[];

    if (violations.length > 0) {
      const v = violations[0];
      this.pauseFund();
      throw new InvariantViolationError(
        'ACCOUNT_BALANCE',
        `token_id=${v.token_id}: current_balance(${v.current_balance}) !== initial_deposit(${v.initial_deposit}) + total_pnl(${v.total_pnl})`,
      );
    }
  }

  private verifyInvariant3_TradeAllocations(): void {
    const violations = this.db.prepare(
      `SELECT t.id AS trade_id, t.profit_loss, COALESCE(SUM(ta.pnl_share), 0) AS alloc_sum
       FROM trades t
       LEFT JOIN trade_allocations ta ON ta.trade_id = t.id
       GROUP BY t.id
       HAVING alloc_sum != t.profit_loss`
    ).all() as { trade_id: number; profit_loss: number; alloc_sum: number }[];

    if (violations.length > 0) {
      const v = violations[0];
      this.pauseFund();
      throw new InvariantViolationError(
        'TRADE_ALLOCATION',
        `trade_id=${v.trade_id}: SUM(pnl_share)=${v.alloc_sum} !== profit_loss=${v.profit_loss}`,
      );
    }
  }

  pauseFund(): void {
    this.db.prepare(
      `UPDATE fund_state SET is_paused = 1, updated_at = datetime('now') WHERE id = 1`
    ).run();
  }

  // ── Staking State Cache ──────────────────────────────────────

  upsertStakingState(state: Omit<StakingState, 'synced_at'>): void {
    this.db.prepare(
      `INSERT INTO nft_staking_state (token_id, owner_tg_id, guardian_address, guardian_endpoint, staked_at, stake_value_cents, delegated_to, delegation_expires, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(token_id) DO UPDATE SET
         owner_tg_id = excluded.owner_tg_id,
         guardian_address = excluded.guardian_address,
         guardian_endpoint = excluded.guardian_endpoint,
         staked_at = excluded.staked_at,
         stake_value_cents = excluded.stake_value_cents,
         delegated_to = excluded.delegated_to,
         delegation_expires = excluded.delegation_expires,
         synced_at = datetime('now')`
    ).run(
      state.token_id, state.owner_tg_id, state.guardian_address, state.guardian_endpoint,
      state.staked_at, state.stake_value_cents, state.delegated_to, state.delegation_expires,
    );
  }

  clearStakingState(tokenId: number): void {
    this.db.prepare(`DELETE FROM nft_staking_state WHERE token_id = ?`).run(tokenId);
  }

  getStakingState(tokenId: number): StakingState | null {
    return (this.db.prepare(
      `SELECT * FROM nft_staking_state WHERE token_id = ?`
    ).get(tokenId) as StakingState | undefined) ?? null;
  }

  getStakingStateByOwner(tgId: string): StakingState[] {
    return this.db.prepare(
      `SELECT * FROM nft_staking_state WHERE owner_tg_id = ? ORDER BY token_id`
    ).all(tgId) as StakingState[];
  }

  getStakingStateByGuardian(guardianAddress: string): StakingState[] {
    return this.db.prepare(
      `SELECT * FROM nft_staking_state WHERE guardian_address = ? ORDER BY token_id`
    ).all(guardianAddress) as StakingState[];
  }

  // ── Governance Config (key-value) ──────────────────────────

  getConfigValue(key: string): string | null {
    const row = this.db.prepare(
      `SELECT value FROM governance_config WHERE key = ?`
    ).get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setConfigValue(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO governance_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(key, value);
  }

  deleteConfigValue(key: string): void {
    this.db.prepare(`DELETE FROM governance_config WHERE key = ?`).run(key);
  }

  // ── Fund State & History ────────────────────────────────────

  getFundState(): FundState {
    return this.db.prepare(`SELECT * FROM fund_state WHERE id = 1`).get() as FundState;
  }

  getTradeHistory(limit: number = 50): Trade[] {
    return this.db.prepare(
      `SELECT * FROM trades ORDER BY id DESC LIMIT ?`
    ).all(limit) as Trade[];
  }

  getTradeAllocations(tradeId: number): TradeAllocation[] {
    return this.db.prepare(
      `SELECT * FROM trade_allocations WHERE trade_id = ? ORDER BY token_id`
    ).all(tradeId) as TradeAllocation[];
  }

  getWithdrawals(tokenId?: number): Withdrawal[] {
    if (tokenId !== undefined) {
      return this.db.prepare(
        `SELECT * FROM withdrawals WHERE token_id = ? ORDER BY id DESC`
      ).all(tokenId) as Withdrawal[];
    }
    return this.db.prepare(
      `SELECT * FROM withdrawals ORDER BY id DESC`
    ).all() as Withdrawal[];
  }

  getFundAdditions(tokenId: number): FundAddition[] {
    return this.db.prepare(
      `SELECT * FROM fund_additions WHERE token_id = ? ORDER BY id DESC`
    ).all(tokenId) as FundAddition[];
  }

  // ── Admin ───────────────────────────────────────────────────

  unpauseFund(): void {
    this.db.prepare(
      `UPDATE fund_state SET is_paused = 0, updated_at = datetime('now') WHERE id = 1`
    ).run();
  }

  setStrategy(strategy: string): void {
    this.db.prepare(
      `UPDATE fund_state SET active_strategy = ?, updated_at = datetime('now') WHERE id = 1`
    ).run(strategy);
  }

  // ── Wallet State ──────────────────────────────────────────

  getWalletState(): WalletState | null {
    return (this.db.prepare(
      `SELECT * FROM wallet_state WHERE id = 1`
    ).get() as WalletState | undefined) ?? null;
  }

  saveWalletState(state: Omit<WalletState, 'id' | 'created_at' | 'updated_at'>): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO wallet_state (id, mnemonic, solana_address, updated_at)
       VALUES (1, ?, ?, datetime('now'))`
    ).run(
      state.mnemonic,
      state.solana_address,
    );
  }

  // ── Balance Snapshots ─────────────────────────────────────

  recordBalanceSnapshot(snapshot: Omit<BalanceSnapshot, 'id' | 'snapshot_at'>): void {
    this.db.prepare(
      `INSERT INTO balance_snapshots (chain, token_symbol, token_mint, amount_raw, decimals, amount_usd_cents)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      snapshot.chain,
      snapshot.token_symbol,
      snapshot.token_mint,
      snapshot.amount_raw,
      snapshot.decimals,
      snapshot.amount_usd_cents,
    );
  }

  getLatestBalanceSnapshots(): BalanceSnapshot[] {
    return this.db.prepare(
      `SELECT bs.*
       FROM balance_snapshots bs
       INNER JOIN (
         SELECT chain, token_symbol, MAX(snapshot_at) AS max_at
         FROM balance_snapshots
         GROUP BY chain, token_symbol
       ) latest ON bs.chain = latest.chain
         AND bs.token_symbol = latest.token_symbol
         AND bs.snapshot_at = latest.max_at
       ORDER BY bs.chain, bs.token_symbol`
    ).all() as BalanceSnapshot[];
  }

  getBalanceHistory(chain: string, tokenSymbol: string, limit: number = 50): BalanceSnapshot[] {
    return this.db.prepare(
      `SELECT * FROM balance_snapshots
       WHERE chain = ? AND token_symbol = ?
       ORDER BY snapshot_at DESC
       LIMIT ?`
    ).all(chain, tokenSymbol, limit) as BalanceSnapshot[];
  }

  // ── Open Positions ──────────────────────────────────────────

  openPosition(pos: Omit<OpenPosition, 'id' | 'opened_at'>): OpenPosition {
    this.guardNotPaused('openPosition');
    const result = this.db.prepare(
      `INSERT INTO open_positions (pair, direction, entry_price_usd, amount_cents, token_amount_raw, entry_signature, strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pos.pair, pos.direction, pos.entry_price_usd,
      pos.amount_cents, pos.token_amount_raw,
      pos.entry_signature, pos.strategy,
    );
    return this.db.prepare(
      `SELECT * FROM open_positions WHERE id = ?`
    ).get(Number(result.lastInsertRowid)) as OpenPosition;
  }

  getOpenPositions(pair?: string): OpenPosition[] {
    if (pair) {
      return this.db.prepare(
        `SELECT * FROM open_positions WHERE pair = ? ORDER BY opened_at DESC`
      ).all(pair) as OpenPosition[];
    }
    return this.db.prepare(
      `SELECT * FROM open_positions ORDER BY opened_at DESC`
    ).all() as OpenPosition[];
  }

  getOpenPosition(id: number): OpenPosition | null {
    return (this.db.prepare(
      `SELECT * FROM open_positions WHERE id = ?`
    ).get(id) as OpenPosition | undefined) ?? null;
  }

  closePosition(id: number): OpenPosition {
    const pos = this.getOpenPosition(id);
    if (!pos) throw new Error(`Open position not found: id=${id}`);
    this.db.prepare(`DELETE FROM open_positions WHERE id = ?`).run(id);
    return pos;
  }

  closeAllPositions(pair?: string): OpenPosition[] {
    const positions = this.getOpenPositions(pair);
    if (pair) {
      this.db.prepare(`DELETE FROM open_positions WHERE pair = ?`).run(pair);
    } else {
      this.db.prepare(`DELETE FROM open_positions`).run();
    }
    return positions;
  }

  // ── Daily Trade Stats ───────────────────────────────────────

  getDailyTradeStats(date?: string): DailyTradeStats {
    const d = date ?? new Date().toISOString().slice(0, 10);
    const result = this.db.prepare(
      `SELECT COUNT(*) AS trade_count, COALESCE(SUM(profit_loss), 0) AS total_pnl
       FROM trades
       WHERE date(created_at) = ?`
    ).get(d) as { trade_count: number; total_pnl: number };

    return {
      date: d,
      tradeCount: result.trade_count,
      totalPnlCents: result.total_pnl,
    };
  }

  // ── Strategy Config ─────────────────────────────────────────

  getStrategyConfig(): TradingConfig {
    const row = this.db.prepare(
      `SELECT * FROM strategy_config WHERE id = 1`
    ).get() as { strategy_id: string; parameters: string; last_updated: string } | undefined;

    if (!row) {
      return { activeStrategy: 'none', parameters: {}, lastUpdated: 0 };
    }

    return {
      activeStrategy: row.strategy_id,
      parameters: JSON.parse(row.parameters) as Record<string, number>,
      lastUpdated: new Date(row.last_updated).getTime(),
    };
  }

  setStrategyConfig(strategyId: string, parameters: Record<string, number>): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO strategy_config (id, strategy_id, parameters, last_updated)
       VALUES (1, ?, ?, datetime('now'))`
    ).run(strategyId, JSON.stringify(parameters));

    // Also update fund_state.active_strategy for consistency
    this.setStrategy(strategyId);
  }

  // ── NFT Collection Config ───────────────────────────────────

  getNFTCollectionConfig(): { collection_address: string; merkle_tree_address: string } | null {
    return (this.db.prepare(
      `SELECT * FROM nft_collection_config WHERE id = 1`
    ).get() as { collection_address: string; merkle_tree_address: string } | undefined) ?? null;
  }

  saveNFTCollectionConfig(collectionAddress: string, merkleTreeAddress: string): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO nft_collection_config (id, collection_address, merkle_tree_address)
       VALUES (1, ?, ?)`
    ).run(collectionAddress, merkleTreeAddress);
  }

  // ── Sentiment Logging ─────────────────────────────────────

  logSentiment(entry: {
    score: number;
    confidence: number;
    reasoning: string;
    extremeEvent: string | null;
    twitterScore: number | null;
    telegramScore: number | null;
    newsScore: number | null;
    blendLayer: string | null;
    strategyAction: string | null;
    blendedAction: string | null;
    rawJson: string;
  }): void {
    this.db.prepare(
      `INSERT INTO sentiment_log
         (score, confidence, reasoning, extreme_event, twitter_score, telegram_score, news_score,
          blend_layer, strategy_action, blended_action, raw_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entry.score,
      entry.confidence,
      entry.reasoning,
      entry.extremeEvent,
      entry.twitterScore,
      entry.telegramScore,
      entry.newsScore,
      entry.blendLayer,
      entry.strategyAction,
      entry.blendedAction,
      entry.rawJson,
    );
  }

  getSentimentLog(limit: number = 10): Array<{
    id: number;
    score: number;
    confidence: number;
    reasoning: string;
    extreme_event: string | null;
    twitter_score: number | null;
    telegram_score: number | null;
    news_score: number | null;
    blend_layer: string | null;
    strategy_action: string | null;
    blended_action: string | null;
    created_at: string;
  }> {
    return this.db.prepare(
      `SELECT id, score, confidence, reasoning, extreme_event,
              twitter_score, telegram_score, news_score,
              blend_layer, strategy_action, blended_action, created_at
       FROM sentiment_log
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(limit) as Array<{
      id: number;
      score: number;
      confidence: number;
      reasoning: string;
      extreme_event: string | null;
      twitter_score: number | null;
      telegram_score: number | null;
      news_score: number | null;
      blend_layer: string | null;
      strategy_action: string | null;
      blended_action: string | null;
      created_at: string;
    }>;
  }

  getSentimentAverage(hours: number = 24): { avgScore: number; avgConfidence: number; count: number } {
    const result = this.db.prepare(
      `SELECT AVG(score) AS avg_score, AVG(confidence) AS avg_confidence, COUNT(*) AS cnt
       FROM sentiment_log
       WHERE created_at >= datetime('now', ? || ' hours')`
    ).get(`-${hours}`) as { avg_score: number | null; avg_confidence: number | null; cnt: number };

    return {
      avgScore: result.avg_score ?? 0,
      avgConfidence: result.avg_confidence ?? 0,
      count: result.cnt,
    };
  }

  // ── Backup Agent Registry ──────────────────────────────────

  /** Register a backup agent. On re-register, keeps existing streak. Returns priority position. */
  registerBackupAgent(id: string, endpoint: string): number {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO backup_agents (id, endpoint, registered_at, last_heartbeat, heartbeat_streak, status)
       VALUES (?, ?, ?, ?, 0, 'active')
       ON CONFLICT(id) DO UPDATE SET
         endpoint = excluded.endpoint,
         last_heartbeat = excluded.last_heartbeat,
         status = 'active'`
    ).run(id, endpoint, now, now);

    // Return position (1-based, ordered by priority: streak DESC, registered_at ASC)
    const row = this.db.prepare(
      `SELECT COUNT(*) AS pos FROM backup_agents
       WHERE heartbeat_streak > (SELECT heartbeat_streak FROM backup_agents WHERE id = ?)
          OR (heartbeat_streak = (SELECT heartbeat_streak FROM backup_agents WHERE id = ?)
              AND registered_at <= (SELECT registered_at FROM backup_agents WHERE id = ?))`
    ).get(id, id, id) as { pos: number };
    return row.pos;
  }

  /** Update heartbeat timestamp for a backup agent. Increments streak if on-time, resets if late. */
  backupAgentHeartbeat(id: string, endpoint?: string): boolean {
    const now = Date.now();
    // 35 min grace window (30 min interval + 5 min grace = 2100000ms)
    const GRACE_MS = 2_100_000;
    let result;
    if (endpoint) {
      result = this.db.prepare(
        `UPDATE backup_agents SET
           last_heartbeat = ?,
           endpoint = ?,
           heartbeat_streak = CASE WHEN (? - last_heartbeat) <= ? THEN heartbeat_streak + 1 ELSE 0 END,
           status = 'active'
         WHERE id = ?`
      ).run(now, endpoint, now, GRACE_MS, id);
    } else {
      result = this.db.prepare(
        `UPDATE backup_agents SET
           last_heartbeat = ?,
           heartbeat_streak = CASE WHEN (? - last_heartbeat) <= ? THEN heartbeat_streak + 1 ELSE 0 END,
           status = 'active'
         WHERE id = ?`
      ).run(now, now, GRACE_MS, id);
    }
    return result.changes > 0;
  }

  /** Get all backup agents ordered by priority (highest streak first, then oldest). */
  getBackupAgents(): Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }> {
    return this.db.prepare(
      `SELECT * FROM backup_agents ORDER BY heartbeat_streak DESC, registered_at ASC`
    ).all() as Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }>;
  }

  /** Get backup agents with fresh heartbeats (within maxStaleMs), ordered by priority. */
  getFreshBackupAgents(maxStaleMs: number): Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }> {
    const cutoff = Date.now() - maxStaleMs;
    return this.db.prepare(
      `SELECT * FROM backup_agents WHERE last_heartbeat > ? ORDER BY heartbeat_streak DESC, registered_at ASC`
    ).all(cutoff) as Array<{ id: string; endpoint: string; registered_at: number; last_heartbeat: number; heartbeat_streak: number; status: string }>;
  }

  /** Remove a backup agent by ID. */
  removeBackupAgent(id: string): boolean {
    const result = this.db.prepare(`DELETE FROM backup_agents WHERE id = ?`).run(id);
    return result.changes > 0;
  }

  /** Prune backup agents whose last heartbeat is older than maxStaleMs. Returns count deleted. */
  pruneStaleBackupAgents(maxStaleMs: number): number {
    const cutoff = Date.now() - maxStaleMs;
    const result = this.db.prepare(
      `DELETE FROM backup_agents WHERE last_heartbeat < ?`
    ).run(cutoff);
    return result.changes;
  }
}
