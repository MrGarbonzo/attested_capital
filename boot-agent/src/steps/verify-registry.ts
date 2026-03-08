/**
 * Step 6: Verify the registry program was deployed correctly.
 */
import { Connection, PublicKey } from '@solana/web3.js';

export async function verifyRegistry(rpcUrl: string, programId: string): Promise<void> {
  console.log('[boot] Step 6: Verify registry deployment');

  const connection = new Connection(rpcUrl, 'confirmed');
  const pubkey = new PublicKey(programId);

  const accountInfo = await connection.getAccountInfo(pubkey);

  if (!accountInfo) {
    throw new Error(`Registry program account not found: ${programId}`);
  }

  if (!accountInfo.executable) {
    throw new Error(`Registry program account is not executable: ${programId}`);
  }

  console.log(`[boot] Registry verified: ${programId} (${accountInfo.data.length} bytes, executable)`);
}
