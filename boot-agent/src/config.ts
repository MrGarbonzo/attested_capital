/**
 * Boot agent configuration types.
 *
 * The boot agent writes sealed config for the agent container.
 * Guardians obtain their vault key via attestation exchange with the agent.
 */

/** Environment variables consumed by the boot agent. */
export interface BootInput {
  telegramBotToken: string;
  telegramGroupChatId: string;
  telegramAlertChatId: string;
  telegramAllowedUsers: string;
  secretAiApiKey: string;
  solanaRpcUrl: string;
  jupiterApiKey: string;
  agentExternalHost: string;
  approvedMeasurements?: string;
}

/** Sealed config written for the agent container. */
export interface AgentSealedConfig {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_GROUP_CHAT_ID: string;
  TELEGRAM_ALERT_CHAT_ID: string;
  TELEGRAM_ALLOWED_USERS: string;
  SECRET_AI_API_KEY: string;
  SOLANA_RPC_URL: string;
  JUPITER_API_KEY: string;
  REGISTRY_PROGRAM_ID: string;
  VAULT_KEY: string;
  AGENT_EXTERNAL_HOST: string;
  APPROVED_MEASUREMENTS: string;
}

/** Format of a sealed JSON file (AES-256-GCM). */
export interface SealedFile {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: 1;
}

/** Result of the full boot sequence. */
export interface BootResult {
  registryProgramId: string;
  vaultKey: string;
  agentConfigPath: string;
}
