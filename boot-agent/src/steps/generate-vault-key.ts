/**
 * Step 4: Generate a 32-byte AES-256 vault key.
 */
import { randomBytes } from 'node:crypto';

export function generateVaultKey(): Buffer {
  console.log('[boot] Step 4: Generate vault key');
  const key = randomBytes(32);
  console.log('[boot] Vault key generated (32 bytes)');
  return key;
}
