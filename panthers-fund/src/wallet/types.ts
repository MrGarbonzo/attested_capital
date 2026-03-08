export type ChainId = 'solana';

export interface WalletAddresses {
  solana: string;
}

export interface WalletInfo {
  mnemonic: string;
  addresses: WalletAddresses;
}

export interface DerivedKeys {
  solana: Uint8Array;   // 32-byte Ed25519 seed
}
