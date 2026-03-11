-- Panthers Fund Manager — Database Schema
-- All monetary values are INTEGER cents ($50.00 = 5000)
-- Solana-only architecture

CREATE TABLE IF NOT EXISTS nft_accounts (
  token_id       INTEGER PRIMARY KEY CHECK (token_id >= 1 AND token_id <= 500),
  owner_telegram_id TEXT NOT NULL,
  owner_address  TEXT NOT NULL,
  initial_deposit INTEGER NOT NULL CHECK (initial_deposit > 0),
  current_balance INTEGER NOT NULL CHECK (current_balance >= 0),
  total_pnl      INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  mint_address   TEXT,                                      -- on-chain cNFT asset ID (null until minted)
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fund_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  total_pool_balance INTEGER NOT NULL DEFAULT 0 CHECK (total_pool_balance >= 0),
  total_nfts_active  INTEGER NOT NULL DEFAULT 0 CHECK (total_nfts_active >= 0),
  active_strategy    TEXT NOT NULL DEFAULT 'none',
  is_paused          INTEGER NOT NULL DEFAULT 0 CHECK (is_paused IN (0, 1)),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy      TEXT NOT NULL,
  pair          TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price   INTEGER NOT NULL,
  exit_price    INTEGER NOT NULL,
  amount        INTEGER NOT NULL CHECK (amount > 0),
  profit_loss   INTEGER NOT NULL,
  signature     TEXT NOT NULL,
  attestation   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trade_allocations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id           INTEGER NOT NULL REFERENCES trades(id),
  token_id           INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  pnl_share          INTEGER NOT NULL,
  balance_at_trade   INTEGER NOT NULL,
  pool_total_at_trade INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id      INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  fee           INTEGER NOT NULL CHECK (fee >= 0),
  net_amount    INTEGER NOT NULL CHECK (net_amount >= 0),
  dest_address  TEXT NOT NULL,
  tx_signature  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS p2p_sales (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id            INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  seller_telegram_id  TEXT NOT NULL,
  buyer_telegram_id   TEXT NOT NULL,
  buyer_address       TEXT NOT NULL,
  sale_price          INTEGER NOT NULL CHECK (sale_price > 0),
  tx_signature        TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fund_additions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id   INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  tx_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS p2p_listings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  token_id            INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  seller_telegram_id  TEXT NOT NULL,
  asking_price        INTEGER NOT NULL CHECK (asking_price > 0),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'sold', 'cancelled')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS p2p_swap_requests (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  proposer_token_id     INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  proposer_telegram_id  TEXT NOT NULL,
  target_token_id       INTEGER NOT NULL REFERENCES nft_accounts(token_id),
  target_telegram_id    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at            TEXT NOT NULL
);

-- ── Wallet + Balance Tracking ───────────────────────────────

CREATE TABLE IF NOT EXISTS wallet_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  mnemonic         TEXT NOT NULL,
  solana_address   TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS balance_snapshots (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  chain            TEXT NOT NULL CHECK (chain = 'solana'),
  token_symbol     TEXT NOT NULL,
  token_mint       TEXT NOT NULL,
  amount_raw       TEXT NOT NULL,
  decimals         INTEGER NOT NULL,
  amount_usd_cents INTEGER,
  snapshot_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Trading Engine ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS open_positions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pair            TEXT NOT NULL,                       -- 'SOL/USDC'
  direction       TEXT NOT NULL CHECK (direction IN ('long', 'short')),
  entry_price_usd REAL NOT NULL,                       -- USD float at time of entry
  amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),  -- position size in cents
  token_amount_raw TEXT NOT NULL,                       -- actual token received (e.g. lamports)
  entry_signature TEXT NOT NULL,                        -- on-chain tx signature
  strategy        TEXT NOT NULL,                        -- strategy that opened this
  opened_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS strategy_config (
  id             INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton
  strategy_id    TEXT NOT NULL DEFAULT 'none',
  parameters     TEXT NOT NULL DEFAULT '{}',            -- JSON blob
  last_updated   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Metaplex cNFT Collection Config ─────────────────────────

CREATE TABLE IF NOT EXISTS nft_collection_config (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  collection_address  TEXT NOT NULL,
  merkle_tree_address TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── NFT Staking State (cached from guardian network) ──────────────

CREATE TABLE IF NOT EXISTS nft_staking_state (
  token_id          INTEGER PRIMARY KEY REFERENCES nft_accounts(token_id),
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

-- ── Governance Config (key-value store for sentry-approved config) ──

CREATE TABLE IF NOT EXISTS governance_config (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Sentiment Logging ──────────────────────────────────────────

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

-- ── Backup Agent Registry ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS backup_agents (
  id              TEXT PRIMARY KEY,           -- ed25519 pubkey (base64)
  endpoint        TEXT NOT NULL,              -- http://ip:port
  registered_at   INTEGER NOT NULL,           -- epoch ms
  last_heartbeat  INTEGER NOT NULL,           -- epoch ms
  heartbeat_streak INTEGER NOT NULL DEFAULT 0, -- current consecutive on-time heartbeats (resets on miss)
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stale'))
);

CREATE INDEX IF NOT EXISTS idx_backup_agents_priority ON backup_agents(heartbeat_streak DESC, registered_at ASC);

-- Ensure strategy_config singleton row exists
INSERT OR IGNORE INTO strategy_config (id, strategy_id, parameters) VALUES (1, 'none', '{}');

-- Indices
CREATE INDEX IF NOT EXISTS idx_open_positions_pair ON open_positions(pair);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_allocations_trade ON trade_allocations(trade_id);
CREATE INDEX IF NOT EXISTS idx_trade_allocations_token ON trade_allocations(token_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_token ON withdrawals(token_id);
CREATE INDEX IF NOT EXISTS idx_fund_additions_token ON fund_additions(token_id);
CREATE INDEX IF NOT EXISTS idx_p2p_sales_token ON p2p_sales(token_id);
CREATE INDEX IF NOT EXISTS idx_p2p_listings_token ON p2p_listings(token_id);
CREATE INDEX IF NOT EXISTS idx_p2p_listings_status ON p2p_listings(status);
CREATE INDEX IF NOT EXISTS idx_nft_accounts_active ON nft_accounts(is_active);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_chain ON balance_snapshots(chain);
CREATE INDEX IF NOT EXISTS idx_balance_snapshots_time ON balance_snapshots(snapshot_at);
CREATE INDEX IF NOT EXISTS idx_p2p_swap_requests_status ON p2p_swap_requests(status);
CREATE INDEX IF NOT EXISTS idx_p2p_swap_requests_proposer ON p2p_swap_requests(proposer_telegram_id);
CREATE INDEX IF NOT EXISTS idx_p2p_swap_requests_target ON p2p_swap_requests(target_telegram_id);
