/**
 * Deploy the Solana registry program via the `solana program deploy` CLI.
 *
 * Anchor programs require the upgradeable BPF loader (multi-step: create buffer,
 * write chunks, finalize) which isn't exposed by @solana/web3.js v1.  We shell
 * out to the Solana CLI instead.
 *
 * The payer keypair must be pre-funded with enough SOL to cover deployment.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';

/** Default path where the .so is baked into the Docker image. */
const DEFAULT_SO_PATH = '/opt/solana-registry/solana_registry.so';

export interface DeployRegistryInput {
  rpcUrl: string;
  /** Path to a pre-funded Solana keypair JSON file. */
  payerKeypairPath: string;
  soPath?: string;
}

export interface DeployRegistryResult {
  programId: string;
}

export async function deployRegistry(input: DeployRegistryInput): Promise<DeployRegistryResult> {
  console.log('[boot] Deploying Solana registry program via CLI...');

  const soPath = input.soPath ?? DEFAULT_SO_PATH;
  if (!existsSync(soPath)) {
    throw new Error(`Registry .so binary not found at ${soPath}. Build it first or set REGISTRY_PROGRAM_ID.`);
  }

  if (!existsSync(input.payerKeypairPath)) {
    throw new Error(`Payer keypair not found at ${input.payerKeypairPath}. Provide a pre-funded keypair via DEPLOYER_KEYPAIR_PATH.`);
  }

  // Generate a fresh program keypair — its pubkey becomes the program ID
  const programKeypair = Keypair.generate();
  const programKeypairPath = join(tmpdir(), `registry-program-${Date.now()}.json`);
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(programKeypair.secretKey)));

  try {
    const cmd = [
      'solana', 'program', 'deploy',
      soPath,
      '--program-id', programKeypairPath,
      '--url', input.rpcUrl,
      '--keypair', input.payerKeypairPath,
      '--commitment', 'confirmed',
    ].join(' ');

    console.log(`[boot] Running: solana program deploy ...`);
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120_000 });
    console.log(`[boot] CLI output: ${output.trim()}`);

    const programId = programKeypair.publicKey.toBase58();
    console.log(`[boot] Registry deployed at: ${programId}`);

    return { programId };
  } finally {
    try { unlinkSync(programKeypairPath); } catch { /* ignore */ }
  }
}
