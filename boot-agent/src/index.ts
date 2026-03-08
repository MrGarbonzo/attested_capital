/**
 * Boot Agent — entry point.
 *
 * Reads env vars, generates secrets, writes sealed config,
 * verifies the registry exists on-chain, and exits so that
 * docker compose can start the agent.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { generateVaultKey } from './steps/generate-vault-key.js';
import { writeSealedConfig } from './steps/write-sealed-config.js';
import { verifyRegistry } from './steps/verify-registry.js';
import { deployRegistry } from './steps/deploy-registry.js';
import type { BootInput } from './config.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/** Get TEE instance ID, or fall back to a dev identifier. */
function getTeeInstanceId(): string {
  const teePath = '/dev/attestation/quote';
  if (existsSync(teePath)) {
    try {
      const quote = readFileSync(teePath);
      return createHash('sha256').update(quote).digest('hex').substring(0, 16);
    } catch { /* fall through */ }
  }
  return 'dev-boot-agent';
}

/**
 * Get code hash from TEE, or fall back to a dev hash.
 *
 * Prefers RTMR3 (container image measurement) which measures the rootfs +
 * docker-compose.yaml — i.e. the exact GHCR image being run. Falls back to
 * mr_enclave for non-TDX environments.
 */
function getCodeHash(): string {
  // Prefer RTMR3 — container image measurement (GHCR identity)
  const rtmr3Path = '/dev/attestation/rtmr3';
  if (existsSync(rtmr3Path)) {
    try {
      return readFileSync(rtmr3Path, 'utf-8').trim();
    } catch { /* fall through */ }
  }
  // Fallback to mr_enclave
  const mrPath = '/dev/attestation/mr_enclave';
  if (existsSync(mrPath)) {
    try {
      return readFileSync(mrPath, 'utf-8').trim();
    } catch { /* fall through */ }
  }
  return createHash('sha256').update('boot-agent-dev').digest('hex');
}

async function main(): Promise<void> {
  console.log('[boot] ════════════════════════════════════════');
  console.log('[boot] Boot Agent starting');
  console.log('[boot] ════════════════════════════════════════');

  // ── Step 1: Read input env vars ──────────────────────────
  console.log('[boot] Step 1: Read environment');
  const bootInput: BootInput = {
    telegramBotToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    telegramGroupChatId: requireEnv('TELEGRAM_GROUP_CHAT_ID'),
    telegramAlertChatId: requireEnv('TELEGRAM_ALERT_CHAT_ID'),
    telegramAllowedUsers: requireEnv('TELEGRAM_ALLOWED_USERS'),
    secretAiApiKey: requireEnv('SECRET_AI_API_KEY'),
    solanaRpcUrl: requireEnv('SOLANA_RPC_URL'),
    jupiterApiKey: requireEnv('JUPITER_API_KEY'),
    agentExternalHost: requireEnv('AGENT_EXTERNAL_HOST'),
    approvedMeasurements: process.env.APPROVED_MEASUREMENTS,
  };
  console.log(`[boot] RPC: ${bootInput.solanaRpcUrl}`);

  // ── Step 2: Generate vault key ────────────────────────────
  const vaultKey = generateVaultKey();
  const vaultKeyHex = vaultKey.toString('hex');

  // ── Step 3: Resolve registry program ID (deploy or verify) ──
  let registryProgramId = process.env.REGISTRY_PROGRAM_ID;

  if (registryProgramId) {
    console.log(`[boot] REGISTRY_PROGRAM_ID set: ${registryProgramId} — verifying on-chain`);
    await verifyRegistry(bootInput.solanaRpcUrl, registryProgramId);
  } else {
    console.log('[boot] REGISTRY_PROGRAM_ID not set — deploying registry program');
    const result = await deployRegistry({ rpcUrl: bootInput.solanaRpcUrl });
    registryProgramId = result.programId;
    await verifyRegistry(bootInput.solanaRpcUrl, registryProgramId);
  }

  // ── Step 4: Write sealed config ──────────────────────────
  const teeInstanceId = getTeeInstanceId();
  const codeHash = getCodeHash();

  const { agentConfigPath, registryIdPath } = writeSealedConfig({
    bootInput,
    registryProgramId,
    vaultKeyHex,
    teeInstanceId,
    codeHash,
  });

  // ── Done ─────────────────────────────────────────────────
  console.log('[boot] ════════════════════════════════════════');
  console.log('[boot] Boot sequence complete');
  console.log(`[boot]   Registry: ${registryProgramId}`);
  console.log(`[boot]   Agent config: ${agentConfigPath}`);
  console.log(`[boot]   Registry ID: ${registryIdPath}`);
  console.log('[boot] ════════════════════════════════════════');
}

main().catch((err) => {
  console.error('[boot] Fatal error:', err);
  process.exit(1);
});
