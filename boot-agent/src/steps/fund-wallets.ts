/**
 * Step 3: Fund agent and guardian Solana wallets with devnet SOL.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const FUND_AMOUNT_SOL = 2; // Enough for ~1000 registry transactions

export interface FundWalletsInput {
  rpcUrl: string;
  agentPubkey?: string;
  guardianPubkey?: string;
}

export async function fundWallets(input: FundWalletsInput): Promise<void> {
  console.log('[boot] Step 3: Fund agent + guardian wallets');

  const connection = new Connection(input.rpcUrl, 'confirmed');

  const pubkeys: { label: string; pubkey: PublicKey }[] = [];

  if (input.agentPubkey) {
    pubkeys.push({ label: 'agent', pubkey: new PublicKey(input.agentPubkey) });
  }
  if (input.guardianPubkey) {
    pubkeys.push({ label: 'guardian', pubkey: new PublicKey(input.guardianPubkey) });
  }

  if (pubkeys.length === 0) {
    console.log('[boot] No wallet pubkeys provided, skipping funding');
    return;
  }

  for (const { label, pubkey } of pubkeys) {
    try {
      // Check existing balance
      const balance = await connection.getBalance(pubkey);
      const balanceSol = balance / LAMPORTS_PER_SOL;

      if (balanceSol >= FUND_AMOUNT_SOL) {
        console.log(`[boot] ${label} wallet already has ${balanceSol.toFixed(2)} SOL, skipping`);
        continue;
      }

      console.log(`[boot] Airdropping ${FUND_AMOUNT_SOL} SOL to ${label} (${pubkey.toBase58()})`);
      const sig = await connection.requestAirdrop(pubkey, FUND_AMOUNT_SOL * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, 'confirmed');
      console.log(`[boot] ${label} funded`);
    } catch (err) {
      console.warn(`[boot] Failed to fund ${label} wallet (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }
}
