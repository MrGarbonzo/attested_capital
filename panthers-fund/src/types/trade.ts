export interface Trade {
  id?: number;
  strategy: string;
  pair: string;
  direction: 'long' | 'short';
  entry_price: number; // INTEGER cents
  exit_price: number; // INTEGER cents
  amount: number; // INTEGER cents (position size)
  profit_loss: number; // INTEGER cents
  signature: string;
  attestation: string;
  created_at?: string;
}

export interface TradeAllocation {
  id: number;
  trade_id: number;
  token_id: number;
  pnl_share: number; // INTEGER cents
  balance_at_trade: number; // INTEGER cents (snapshot)
  pool_total_at_trade: number; // INTEGER cents (snapshot)
  created_at: string;
}

export interface Withdrawal {
  id: number;
  token_id: number;
  amount: number; // INTEGER cents (gross)
  fee: number; // INTEGER cents
  net_amount: number; // INTEGER cents (amount - fee)
  dest_address: string;
  tx_signature: string;
  created_at: string;
}

export interface P2PSale {
  id: number;
  token_id: number;
  seller_telegram_id: string;
  buyer_telegram_id: string;
  buyer_address: string;
  sale_price: number; // INTEGER cents
  tx_signature: string;
  created_at: string;
}

export interface P2PListing {
  id: number;
  token_id: number;
  seller_telegram_id: string;
  asking_price: number; // INTEGER cents
  status: 'active' | 'sold' | 'cancelled';
  created_at: string;
  updated_at: string;
}

export interface SwapRequest {
  id: number;
  proposer_token_id: number;
  proposer_telegram_id: string;
  target_token_id: number;
  target_telegram_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'cancelled' | 'expired';
  created_at: string;
  updated_at: string;
  expires_at: string;
}
