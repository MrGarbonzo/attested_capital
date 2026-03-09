/**
 * Boot agent configuration types.
 *
 * Boot-agent is a one-shot bootstrapper that deploys the Solana registry
 * and the agent VM. Guardians are deployed separately with the agent's
 * registry details hardcoded at build time (part of their attestation).
 */

/** Environment variables consumed by the boot agent. */
export interface BootInput {
  telegramAgentBotToken: string;
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

/** Format of a sealed JSON file (AES-256-GCM). */
export interface SealedFile {
  ciphertext: string;
  iv: string;
  authTag: string;
  version: 1;
}
