/**
 * Deploy the Solana registry program via the `solana program deploy` CLI.
 *
 * Anchor programs require the upgradeable BPF loader (multi-step: create buffer,
 * write chunks, finalize) which isn't exposed by @solana/web3.js v1.  We shell
 * out to the Solana CLI instead.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

/** Default path where the .so is baked into the Docker image. */
const DEFAULT_SO_PATH = '/opt/solana-registry/solana_registry.so';

/** SOL needed to cover program deployment on devnet. */
const DEPLOY_AIRDROP_SOL = 5;

export interface DeployRegistryInput {
  rpcUrl: string;
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

  // Generate a fresh program keypair — its pubkey becomes the program ID
  const programKeypair = Keypair.generate();
  const programKeypairPath = join(tmpdir(), `registry-program-${Date.now()}.json`);
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(programKeypair.secretKey)));

  // Generate a temporary deployer/payer keypair
  const payerKeypair = Keypair.generate();
  const payerKeypairPath = join(tmpdir(), `registry-payer-${Date.now()}.json`);
  writeFileSync(payerKeypairPath, JSON.stringify(Array.from(payerKeypair.secretKey)));

  try {
    // Fund the payer via airdrop (devnet)
    const connection = new Connection(input.rpcUrl, 'confirmed');
    console.log(`[boot] Requesting ${DEPLOY_AIRDROP_SOL} SOL airdrop for deployer ${payerKeypair.publicKey.toBase58()}`);
    const sig = await connection.requestAirdrop(
      payerKeypair.publicKey,
      DEPLOY_AIRDROP_SOL * LAMPORTS_PER_SOL,
    );
    await connection.confirmTransaction(sig, 'confirmed');
    console.log(`[boot] Airdrop confirmed`);

    // Deploy via CLI
    const cmd = [
      'solana', 'program', 'deploy',
      soPath,
      '--program-id', programKeypairPath,
      '--url', input.rpcUrl,
      '--keypair', payerKeypairPath,
      '--commitment', 'confirmed',
    ].join(' ');

    console.log(`[boot] Running: solana program deploy ...`);
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 120_000 });
    console.log(`[boot] CLI output: ${output.trim()}`);

    const programId = programKeypair.publicKey.toBase58();
    console.log(`[boot] Registry deployed at: ${programId}`);

    return { programId };
  } finally {
    // Clean up temp keypair files
    try { unlinkSync(programKeypairPath); } catch { /* ignore */ }
    try { unlinkSync(payerKeypairPath); } catch { /* ignore */ }
  }
}
