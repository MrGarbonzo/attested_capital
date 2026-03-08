/**
 * Unseal boot-agent config on startup.
 *
 * Checks for /mnt/secure/boot-config/agent.sealed.json.
 * If present: derives the sealing key (same TEE identity as boot-agent),
 * decrypts, and injects values into process.env.
 * If absent: falls through to normal env var reading (dev mode).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unseal, deriveSealingKey, type SealedFile } from './seal.js';

const SEALED_CONFIG_PATH = '/mnt/secure/boot-config/agent.sealed.json';

/** TEE identity resolution — matches boot-agent/src/index.ts logic. */
function getBootTeeInstanceId(): string {
  const teePath = '/dev/attestation/quote';
  if (existsSync(teePath)) {
    try {
      const quote = readFileSync(teePath);
      return createHash('sha256').update(quote).digest('hex').substring(0, 16);
    } catch { /* fall through */ }
  }
  return 'dev-boot-agent';
}

function getBootCodeHash(): string {
  // Must match boot-agent/src/index.ts getCodeHash() — RTMR3 first
  const rtmr3Path = '/dev/attestation/rtmr3';
  if (existsSync(rtmr3Path)) {
    try { return readFileSync(rtmr3Path, 'utf-8').trim(); }
    catch { /* fall through */ }
  }
  const mrPath = '/dev/attestation/mr_enclave';
  if (existsSync(mrPath)) {
    try { return readFileSync(mrPath, 'utf-8').trim(); }
    catch { /* fall through */ }
  }
  return createHash('sha256').update('boot-agent-dev').digest('hex');
}

/**
 * Attempt to unseal agent config from boot-agent's sealed file.
 * Sets process.env.* for each config key if successful.
 * Returns true if config was unsealed, false if no sealed file found.
 */
export function unsealConfig(): boolean {
  if (!existsSync(SEALED_CONFIG_PATH)) {
    console.log('[unseal] No sealed config found — using env vars directly (dev mode)');
    return false;
  }

  console.log(`[unseal] Found sealed config at ${SEALED_CONFIG_PATH}`);

  const teeInstanceId = getBootTeeInstanceId();
  const codeHash = getBootCodeHash();
  const sealingKey = deriveSealingKey(teeInstanceId, codeHash);

  const sealedJson = readFileSync(SEALED_CONFIG_PATH, 'utf-8');
  const sealed: SealedFile = JSON.parse(sealedJson);
  const plaintext = unseal(sealingKey, sealed);
  const config = JSON.parse(plaintext.toString('utf-8')) as Record<string, string>;

  let injected = 0;
  for (const [key, value] of Object.entries(config)) {
    if (value && !process.env[key]) {
      process.env[key] = value;
      injected++;
    }
  }

  console.log(`[unseal] Injected ${injected} config values from sealed file`);
  return true;
}
