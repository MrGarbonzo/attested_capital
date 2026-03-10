/**
 * Deploy the agent VM via secretvm-cli.
 *
 * Generates docker-compose and .env files from config values,
 * then calls `secretvm-cli vm create` for the agent.
 *
 * Guardians are deployed separately with the agent's registry details
 * hardcoded at build time — this makes them attestable as pointing to
 * the correct agent.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootInput } from '../config.js';

export interface DeployAgentVmInput {
  bootInput: BootInput;
  registryProgramId: string;
  vaultKeyHex: string;
  /** GHCR image tag for the agent, e.g. "main-abc1234" */
  agentImageTag: string;
  /** SecretVM size: small | medium | large */
  vmSize: string;
  /** Deploy in dev mode (SSH access enabled) */
  devMode: boolean;
}

export interface DeployAgentVmResult {
  agentVmId: string;
  /** Agent VM domain (e.g. "gold-cougar.vm.scrtlabs.com"), if extractable from CLI output. */
  agentDomain?: string;
}

const GHCR_REGISTRY = 'ghcr.io';
const AGENT_IMAGE = 'mrgarbonzo/agent';

function writeTemp(name: string, content: string): string {
  const path = join(tmpdir(), `boot-${name}-${Date.now()}`);
  writeFileSync(path, content, 'utf-8');
  return path;
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
      - /mnt/secure/system_info.json:/mnt/secure/system_info.json:ro
      - /mnt/secure/self_report.txt:/mnt/secure/self_report.txt:ro
      - /mnt/secure/tdx_attestation.txt:/mnt/secure/tdx_attestation.txt:ro
      - /mnt/secure/docker_public_key_ed25519.pem:/mnt/secure/docker_public_key_ed25519.pem:ro
      - /mnt/secure/docker_attestation_ed25519.txt:/mnt/secure/docker_attestation_ed25519.txt:ro
    env_file: .env

volumes:
  agent-data:
`;
}

function buildAgentEnv(input: DeployAgentVmInput): string {
  const lines = [
    `TELEGRAM_BOT_TOKEN=${input.bootInput.telegramAgentBotToken}`,
    `TELEGRAM_GROUP_CHAT_ID=${input.bootInput.telegramGroupChatId}`,
    `SECRET_AI_API_KEY=${input.bootInput.secretAiApiKey}`,
    `SOLANA_RPC_URL=${input.bootInput.solanaRpcUrl}`,
    `JUPITER_API_KEY=${input.bootInput.jupiterApiKey}`,
    `REGISTRY_PROGRAM_ID=${input.registryProgramId}`,
    `VAULT_KEY=${input.vaultKeyHex}`,
    `APPROVED_MEASUREMENTS=${input.bootInput.approvedMeasurements ?? ''}`,
    `MOCK_NFT=${process.env.MOCK_NFT ?? 'false'}`,
    `STATUS_PORT=8080`,
    `PANTHERS_DB_PATH=/data/panthers.db`,
  ];
  return lines.join('\n') + '\n';
}

export function deployAgentVm(input: DeployAgentVmInput): DeployAgentVmResult {
  console.log('[boot] ── Deploying agent VM via secretvm-cli ──');

  const composePath = writeTemp('agent-compose.yml', buildAgentCompose(input.agentImageTag));
  const envPath = writeTemp('agent.env', buildAgentEnv(input));

  try {
    const apiKey = input.bootInput.secretAiApiKey;
    const cmd = [
      'secretvm-cli', '-k', apiKey, 'vm', 'create',
      '-n', 'panthers-agent',
      '-t', input.vmSize,
      '-d', composePath,
      '-e', envPath,
      '-r', GHCR_REGISTRY,
      '-s',  // TLS enabled
      '-p',  // persistence across reboots
      ...(input.devMode ? ['-E', 'dev'] : []),
    ].join(' ');

    console.log('[boot] Running: secretvm-cli vm create -n panthers-agent ...');
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 300_000 });
    console.log(`[boot] Agent VM output: ${output.trim()}`);

    // Extract VM ID from output
    const idMatch = output.match(/([0-9a-f-]{36})/i);
    const agentVmId = idMatch?.[1] ?? 'unknown';
    console.log(`[boot] Agent VM created: ${agentVmId}`);

    // Extract domain from output (e.g. "gold-cougar.vm.scrtlabs.com")
    const domainMatch = output.match(/([a-z]+-[a-z]+\.vm\.scrtlabs\.com)/i);
    const agentDomain = domainMatch?.[1];
    if (agentDomain) {
      console.log(`[boot] Agent VM domain: ${agentDomain}`);
    } else {
      console.warn('[boot] Could not extract agent domain from CLI output');
    }

    return { agentVmId, agentDomain };
  } finally {
    try { unlinkSync(composePath); } catch { /* ignore */ }
    try { unlinkSync(envPath); } catch { /* ignore */ }
  }
}
