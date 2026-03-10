/**
 * Deploy the Solana registry program via the `solana program deploy` CLI.
 *
 * Generates a deployer keypair inside the TEE, prints the address, and polls
 * until sufficient SOL is received before proceeding with deployment.
 * The private key never leaves the TEE.
 */
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

/** Default path where the .so is baked into the Docker image. */
const DEFAULT_SO_PATH = '/opt/solana-registry/solana_registry.so';

/** Minimum SOL needed to deploy the registry program. */
const MIN_DEPLOY_SOL = 3;

/** How often to check for funding (ms). */
const POLL_INTERVAL_MS = 10_000;

/** Max time to wait for funding (ms). */
const POLL_TIMEOUT_MS = 30 * 60_000; // 30 minutes

export interface DeployRegistryInput {
  rpcUrl: string;
  soPath?: string;
}

export interface DeployRegistryResult {
  programId: string;
  /** Raw deployer secret key (64 bytes). Caller should transfer remaining SOL then zero this. */
  payerSecretKey: Uint8Array;
}

async function waitForFunding(connection: Connection, publicKey: import('@solana/web3.js').PublicKey): Promise<void> {
  const start = Date.now();
  const address = publicKey.toBase58();

  console.log('[boot] ════════════════════════════════════════');
  console.log('[boot] FUNDING REQUIRED');
  console.log(`[boot] Send at least ${MIN_DEPLOY_SOL} SOL to:`);
  console.log(`[boot]   ${address}`);
  console.log('[boot] Waiting for funds...');
  console.log('[boot] ════════════════════════════════════════');

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const balance = await connection.getBalance(publicKey);
      const sol = balance / LAMPORTS_PER_SOL;

      if (sol >= MIN_DEPLOY_SOL) {
        console.log(`[boot] Funded! Balance: ${sol} SOL`);
        return;
      }

      if (balance > 0) {
        console.log(`[boot] Received ${sol} SOL — need at least ${MIN_DEPLOY_SOL} SOL`);
      }
    } catch (err) {
      console.warn(`[boot] RPC poll error: ${err instanceof Error ? err.message : err}`);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for funding after ${POLL_TIMEOUT_MS / 60_000} minutes`);
}

export async function deployRegistry(input: DeployRegistryInput): Promise<DeployRegistryResult> {
  console.log('[boot] Deploying Solana registry program via CLI...');

  const soPath = input.soPath ?? DEFAULT_SO_PATH;
  if (!existsSync(soPath)) {
    throw new Error(`Registry .so binary not found at ${soPath}. Build it first or set REGISTRY_PROGRAM_ID.`);
  }

  const connection = new Connection(input.rpcUrl, 'confirmed');

  // Generate deployer keypair inside TEE — private key never leaves
  const payerKeypair = Keypair.generate();
  const payerKeypairPath = join(tmpdir(), `registry-payer-${Date.now()}.json`);
  writeFileSync(payerKeypairPath, JSON.stringify(Array.from(payerKeypair.secretKey)));

  // Generate program keypair — its pubkey becomes the program ID
  const programKeypair = Keypair.generate();
  const programKeypairPath = join(tmpdir(), `registry-program-${Date.now()}.json`);
  writeFileSync(programKeypairPath, JSON.stringify(Array.from(programKeypair.secretKey)));

  try {
    // Wait for operator to fund the deployer address
    await waitForFunding(connection, payerKeypair.publicKey);

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

    // Keep payer secret key so caller can transfer remaining SOL to the agent
    const payerSecretKey = Uint8Array.from(payerKeypair.secretKey);

    return { programId, payerSecretKey };
  } finally {
    try { unlinkSync(payerKeypairPath); } catch { /* ignore */ }
    try { unlinkSync(programKeypairPath); } catch { /* ignore */ }
  }
}
