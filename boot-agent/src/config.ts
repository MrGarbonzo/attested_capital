/**
 * Boot agent configuration types.
 *
 * The boot agent writes sealed config for the agent container.
 * Guardians obtain their vault key via attestation exchange with the agent.
 */

/** Environment variables consumed by the boot agent. */
export interface BootInput {
  telegramAgentBotToken: string;
  telegramGuardianBotToken: string;
  telegramGroupChatId: string;
  secretAiApiKey: string;
  solanaRpcUrl: string;
  jupiterApiKey: string;
  approvedMeasurements?: string;
}

/** Sealed config written for the agent container. */
export interface AgentSealedConfig {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_GROUP_CHAT_ID: string;
  SECRET_AI_API_KEY: string;
  SOLANA_RPC_URL: string;
  JUPITER_API_KEY: string;
  REGISTRY_PROGRAM_ID: string;
  VAULT_KEY: string;
  APPROVED_MEASUREMENTS: string;
}

/** Sealed config written for the guardian container. */
export interface GuardianSealedConfig {
  GUARDIAN_TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_GROUP_CHAT_ID: string;
  SOLANA_RPC_URL: string;
  REGISTRY_PROGRAM_ID: string;
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
