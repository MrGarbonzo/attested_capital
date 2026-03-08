export interface NFTAccount {
  token_id: number;
  owner_telegram_id: string;
  owner_address: string;
  initial_deposit: number; // INTEGER cents
  current_balance: number; // INTEGER cents
  total_pnl: number; // INTEGER cents
  is_active: number; // 0 or 1
  mint_address: string | null; // on-chain cNFT asset ID
  created_at: string;
  updated_at: string;
}

export interface FundState {
  id: number;
  total_pool_balance: number; // INTEGER cents
  total_nfts_active: number;
  active_strategy: string;
  is_paused: number; // 0 or 1
  updated_at: string;
}

export interface StakingState {
  token_id: number;
  owner_tg_id: string;
  guardian_address: string;
  guardian_endpoint: string;
  staked_at: string;
  stake_value_cents: number;
  delegated_to: string | null;
  delegation_expires: string | null;
  synced_at: string;
}

export interface FundAddition {
  id: number;
  token_id: number;
  amount: number; // INTEGER cents
  tx_hash: string;
  created_at: string;
}
