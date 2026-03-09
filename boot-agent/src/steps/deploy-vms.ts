/**
 * Deploy agent and guardian VMs via secretvm-cli.
 *
 * Generates docker-compose and .env files from sealed config values,
 * then calls `secretvm-cli vm create` for each.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootInput } from '../config.js';

export interface DeployVmsInput {
  bootInput: BootInput;
  registryProgramId: string;
  vaultKeyHex: string;
  /** GHCR image tag for the agent, e.g. "main-abc1234" */
  agentImageTag: string;
  /** GHCR image tag for the guardian, e.g. "main-abc1234" */
  guardianImageTag: string;
  /** SecretVM size: small | medium | large */
  vmSize: string;
}

export interface DeployVmsResult {
  agentVmId: string;
  guardianVmId: string;
}

const GHCR_REGISTRY = 'ghcr.io';
const AGENT_IMAGE = 'mrgarbonzo/agent';
const GUARDIAN_IMAGE = 'mrgarbonzo/guardian';

function writeTemp(name: string, content: string): string {
  const path = join(tmpdir(), `boot-${name}-${Date.now()}`);
  writeFileSync(path, content, 'utf-8');
  return path;
}

function cleanupFiles(...paths: string[]): void {
  for (const p of paths) {
    try { unlinkSync(p); } catch { /* ignore */ }
  }
}

function createVm(opts: {
  name: string;
  composePath: string;
  envPath: string;
  vmSize: string;
}): string {
  const cmd = [
    'secretvm-cli', 'vm', 'create',
    '-n', opts.name,
    '-t', opts.vmSize,
    '-d', opts.composePath,
    '-e', opts.envPath,
    '-r', GHCR_REGISTRY,
    '-s',  // TLS enabled
    '-p',  // persistence across reboots
  ].join(' ');

  console.log(`[boot] Running: secretvm-cli vm create -n ${opts.name} ...`);
  const output = execSync(cmd, { encoding: 'utf-8', timeout: 300_000 });
  console.log(`[boot] ${opts.name} VM output: ${output.trim()}`);

  // Extract VM ID from output (secretvm-cli prints it on creation)
  const idMatch = output.match(/([0-9a-f-]{36})/i);
  return idMatch?.[1] ?? 'unknown';
}

function buildAgentCompose(imageTag: string): string {
  return `version: "3.8"

services:
  agent:
    image: ${GHCR_REGISTRY}/${AGENT_IMAGE}:${imageTag}
    container_name: panthers-agent
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - agent-data:/data
    env_file: .env

volumes:
  agent-data:
`;
}

function buildGuardianCompose(imageTag: string): string {
  return `version: "3.8"

services:
  guardian:
    image: ${GHCR_REGISTRY}/${GUARDIAN_IMAGE}:${imageTag}
    container_name: panthers-guardian
    restart: unless-stopped
    ports:
      - "3100:3100"
    volumes:
      - guardian-data:/data
      - /mnt/secure/docker_public_key_ed25519.pem:/mnt/secure/docker_public_key_ed25519.pem:ro
      - /mnt/secure/docker_attestation_ed25519.txt:/mnt/secure/docker_attestation_ed25519.txt:ro
    env_file: .env

volumes:
  guardian-data:
`;
}

function buildAgentEnv(input: DeployVmsInput): string {
  const lines = [
    `TELEGRAM_BOT_TOKEN=${input.bootInput.telegramAgentBotToken}`,
    `TELEGRAM_GROUP_CHAT_ID=${input.bootInput.telegramGroupChatId}`,
    `TELEGRAM_ALERT_CHAT_ID=${input.bootInput.telegramAlertChatId}`,
    `TELEGRAM_ALLOWED_USERS=${input.bootInput.telegramAllowedUsers}`,
    `SECRET_AI_API_KEY=${input.bootInput.secretAiApiKey}`,
    `SOLANA_RPC_URL=${input.bootInput.solanaRpcUrl}`,
    `JUPITER_API_KEY=${input.bootInput.jupiterApiKey}`,
    `REGISTRY_PROGRAM_ID=${input.registryProgramId}`,
    `VAULT_KEY=${input.vaultKeyHex}`,
    `AGENT_EXTERNAL_HOST=${input.bootInput.agentExternalHost}`,
    `APPROVED_MEASUREMENTS=${input.bootInput.approvedMeasurements ?? ''}`,
    `STATUS_PORT=8080`,
    `PANTHERS_DB_PATH=/data/panthers.db`,
  ];
  return lines.join('\n') + '\n';
}

function buildGuardianEnv(input: DeployVmsInput): string {
  const lines = [
    `GUARDIAN_TELEGRAM_BOT_TOKEN=${input.bootInput.telegramGuardianBotToken}`,
    `TELEGRAM_GROUP_CHAT_ID=${input.bootInput.telegramGroupChatId}`,
    `TELEGRAM_ALERT_CHAT_ID=${input.bootInput.telegramAlertChatId}`,
    `SOLANA_RPC_URL=${input.bootInput.solanaRpcUrl}`,
    `REGISTRY_PROGRAM_ID=${input.registryProgramId}`,
    `APPROVED_MEASUREMENTS=${input.bootInput.approvedMeasurements ?? ''}`,
    `GUARDIAN_ADDRESS=guardian-1`,
    `PORT=3100`,
    `GUARDIAN_EXTERNAL_ENDPOINT=http://0.0.0.0:3100`,
    `DB_PATH=/data/guardian.db`,
    `MAX_BACKUPS=1000`,
    `IS_SENTRY=true`,
    `SECRETVM_SIGN_ENDPOINT=http://172.17.0.1:49153/sign`,
    `SECRETVM_PUBKEY_PEM_PATH=/mnt/secure/docker_public_key_ed25519.pem`,
    `SECRETVM_ATTESTATION_PATH=/mnt/secure/docker_attestation_ed25519.txt`,
  ];
  return lines.join('\n') + '\n';
}

export function deployVms(input: DeployVmsInput): DeployVmsResult {
  console.log('[boot] ── Deploying VMs via secretvm-cli ──');

  // Write temp files
  const agentComposePath = writeTemp('agent-compose.yml', buildAgentCompose(input.agentImageTag));
  const agentEnvPath = writeTemp('agent.env', buildAgentEnv(input));
  const guardianComposePath = writeTemp('guardian-compose.yml', buildGuardianCompose(input.guardianImageTag));
  const guardianEnvPath = writeTemp('guardian.env', buildGuardianEnv(input));

  try {
    // Deploy agent VM
    const agentVmId = createVm({
      name: 'panthers-agent',
      composePath: agentComposePath,
      envPath: agentEnvPath,
      vmSize: input.vmSize,
    });
    console.log(`[boot] Agent VM created: ${agentVmId}`);

    // Deploy guardian VM
    const guardianVmId = createVm({
      name: 'panthers-guardian',
      composePath: guardianComposePath,
      envPath: guardianEnvPath,
      vmSize: input.vmSize,
    });
    console.log(`[boot] Guardian VM created: ${guardianVmId}`);

    return { agentVmId, guardianVmId };
  } finally {
    cleanupFiles(agentComposePath, agentEnvPath, guardianComposePath, guardianEnvPath);
  }
}
