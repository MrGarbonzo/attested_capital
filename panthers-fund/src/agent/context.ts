import { DatabaseLedger } from '../database/ledger.js';
import { MultiChainWallet } from '../wallet/multi-chain-wallet.js';
import { JupiterClient } from '../jupiter/jupiter-client.js';
import { BalanceTracker } from '../balance/balance-tracker.js';
import type { RpcConfig } from '../balance/types.js';
import type { NFTMinter } from '../nft/minter.js';
import type { ResilientLLM } from './resilient-llm.js';

export interface DiscoveredGuardian {
  address: string;
  endpoint: string;
  isSentry: boolean;
  discoveredAt: number;
  lastSeen: number;
  verified: boolean;
  /** Telegram user ID of the guardian's bot (for admin promotion). */
  telegramUserId?: number;
}

export interface ServiceContext {
  db: DatabaseLedger;
  wallet: MultiChainWallet;
  jupiter: JupiterClient;
  tracker: BalanceTracker;
  rpc: RpcConfig;
  discoveredGuardians: Map<string, DiscoveredGuardian>;
  groupChatId?: number;
  nftMinter?: NFTMinter;
  sentimentLlm?: ResilientLLM;
}

export interface ContextConfig {
  dbPath: string;
  solanaRpcUrl: string;
  jupiterApiKey?: string;
}

let _ctx: ServiceContext | null = null;

/**
 * Initialize the shared service context. Called once on startup.
 * First boot: generates mnemonic + persists to wallet_state table.
 * Subsequent boots: restores wallet from DB.
 */
export function initContext(config: ContextConfig): ServiceContext {
  if (_ctx) return _ctx;

  const db = new DatabaseLedger(config.dbPath);
  const wallet = MultiChainWallet.initializeFromDB(db.db);

  const jupiter = new JupiterClient({
    rpcUrl: config.solanaRpcUrl,
    keypair: wallet.getSolanaKeypair(),
    apiKey: config.jupiterApiKey,
  });

  const rpc: RpcConfig = {
    solanaRpcUrl: config.solanaRpcUrl,
  };

  const tracker = new BalanceTracker(wallet.addresses, rpc, db.db);

  _ctx = { db, wallet, jupiter, tracker, rpc, discoveredGuardians: new Map() };
  return _ctx;
}

/** Get the initialized context. Throws if initContext hasn't been called. */
export function getContext(): ServiceContext {
  if (!_ctx) {
    throw new Error('ServiceContext not initialized — call initContext() first');
  }
  return _ctx;
}
