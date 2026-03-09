/**
 * Seal and write config for the agent container.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { seal, deriveSealingKey } from '../sealed/seal.js';
import type { BootInput, AgentSealedConfig, GuardianSealedConfig } from '../config.js';

const AGENT_CONFIG_PATH = '/mnt/secure/boot-config/agent.sealed.json';
const GUARDIAN_CONFIG_PATH = '/mnt/secure/boot-config/guardian.sealed.json';
const REGISTRY_ID_PATH = '/mnt/secure/boot-config/registry-program-id.txt';

export interface WriteSealedConfigInput {
  bootInput: BootInput;
  registryProgramId: string;
  vaultKeyHex: string;
  teeInstanceId: string;
  codeHash: string;
}

export interface WriteSealedConfigResult {
  agentConfigPath: string;
  guardianConfigPath: string;
  registryIdPath: string;
}

export function writeSealedConfig(input: WriteSealedConfigInput): WriteSealedConfigResult {
  console.log('[boot] Writing sealed agent config');

  const sealingKey = deriveSealingKey(input.teeInstanceId, input.codeHash);

  // Build agent config
  const agentConfig: AgentSealedConfig = {
    TELEGRAM_BOT_TOKEN: input.bootInput.telegramAgentBotToken,
    TELEGRAM_GROUP_CHAT_ID: input.bootInput.telegramGroupChatId,
    TELEGRAM_ALERT_CHAT_ID: input.bootInput.telegramAlertChatId,
    TELEGRAM_ALLOWED_USERS: input.bootInput.telegramAllowedUsers,
    SECRET_AI_API_KEY: input.bootInput.secretAiApiKey,
    SOLANA_RPC_URL: input.bootInput.solanaRpcUrl,
    JUPITER_API_KEY: input.bootInput.jupiterApiKey,
    REGISTRY_PROGRAM_ID: input.registryProgramId,
    VAULT_KEY: input.vaultKeyHex,
    AGENT_EXTERNAL_HOST: input.bootInput.agentExternalHost,
    APPROVED_MEASUREMENTS: input.bootInput.approvedMeasurements ?? '',
  };

  // Build guardian config
  const guardianConfig: GuardianSealedConfig = {
    GUARDIAN_TELEGRAM_BOT_TOKEN: input.bootInput.telegramGuardianBotToken,
    TELEGRAM_GROUP_CHAT_ID: input.bootInput.telegramGroupChatId,
    TELEGRAM_ALERT_CHAT_ID: input.bootInput.telegramAlertChatId,
    SOLANA_RPC_URL: input.bootInput.solanaRpcUrl,
    REGISTRY_PROGRAM_ID: input.registryProgramId,
    APPROVED_MEASUREMENTS: input.bootInput.approvedMeasurements ?? '',
  };

  // Seal and write agent config
  const agentPlaintext = Buffer.from(JSON.stringify(agentConfig), 'utf-8');
  const agentSealed = seal(sealingKey, agentPlaintext);
  ensureDir(AGENT_CONFIG_PATH);
  writeFileSync(AGENT_CONFIG_PATH, JSON.stringify(agentSealed), 'utf-8');
  console.log(`[boot] Agent config sealed to ${AGENT_CONFIG_PATH}`);

  // Seal and write guardian config
  const guardianPlaintext = Buffer.from(JSON.stringify(guardianConfig), 'utf-8');
  const guardianSealed = seal(sealingKey, guardianPlaintext);
  ensureDir(GUARDIAN_CONFIG_PATH);
  writeFileSync(GUARDIAN_CONFIG_PATH, JSON.stringify(guardianSealed), 'utf-8');
  console.log(`[boot] Guardian config sealed to ${GUARDIAN_CONFIG_PATH}`);

  // Write registry program ID as plain text for easy retrieval
  ensureDir(REGISTRY_ID_PATH);
  writeFileSync(REGISTRY_ID_PATH, input.registryProgramId, 'utf-8');
  console.log(`[boot] Registry program ID written to ${REGISTRY_ID_PATH}`);

  return {
    agentConfigPath: AGENT_CONFIG_PATH,
    guardianConfigPath: GUARDIAN_CONFIG_PATH,
    registryIdPath: REGISTRY_ID_PATH,
  };
}

function ensureDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
