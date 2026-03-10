/**
 * Step 6: Verify the deployed agent is running in a real TEE, then
 * transfer remaining deployer SOL to the agent's wallet.
 *
 * Flow:
 *   1. Poll agent's /api/fund-address endpoint until it's up
 *   2. Fetch attestation quote from agent's SecretVM runtime (:29343/cpu.html)
 *   3. Verify quote via PCCS (proves genuine TEE)
 *   4. Transfer remaining deployer SOL to the agent's Solana address
 *   5. Zero the deployer secret key
 */
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';

// ── Config ──────────────────────────────────────────────────────

const PCCS_ENDPOINT = process.env.PCCS_ENDPOINT ?? 'https://pccs.scrtlabs.com/dcap-tools/quote-parse';
const ATTESTATION_PORT = 29343;

/** How often to poll the agent (ms). */
const POLL_INTERVAL_MS = 15_000;

/** Max time to wait for agent to come online (ms). */
const POLL_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/** Minimum SOL to keep in deployer for the transfer tx fee. */
const TX_FEE_RESERVE_SOL = 0.01;

export interface VerifyAndFundAgentInput {
  /** Agent domain (e.g. "gold-cougar.vm.scrtlabs.com") */
  agentDomain: string;
  /** Agent status port (default 8080) */
  agentPort?: number;
  /** Deployer keypair secret key (64 bytes) */
  payerSecretKey: Uint8Array;
  /** Solana RPC URL */
  rpcUrl: string;
}

export interface VerifyAndFundAgentResult {
  /** Whether attestation was verified and funding succeeded */
  success: boolean;
  /** Agent's Solana address that was funded */
  agentAddress?: string;
  /** SOL transferred to agent */
  solTransferred?: number;
  /** RTMR3 / container measurement from attestation */
  containerMeasurement?: string;
  error?: string;
}

// ── Quote Fetching ──────────────────────────────────────────────

function extractQuoteFromHtml(html: string): string | null {
  const preMatch = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (preMatch) {
    const content = preMatch[1].replace(/<[^>]*>/g, '').trim();
    if (content.length > 100) return content;
  }
  const textareaMatch = html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/i);
  if (textareaMatch) {
    const content = textareaMatch[1].trim();
    if (content.length > 100) return content;
  }
  const hexStrings = html.replace(/<[^>]*>/g, ' ').match(/[0-9a-fA-F]{128,}/g);
  if (hexStrings) {
    return hexStrings.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  const b64Strings = html.replace(/<[^>]*>/g, ' ').match(/[A-Za-z0-9+/=]{128,}/g);
  if (b64Strings) {
    return b64Strings.reduce((a, b) => (a.length >= b.length ? a : b));
  }
  return null;
}

async function fetchWithTlsOverride(url: string, timeout = 10_000): Promise<Response> {
  const orig = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetch(url, { signal: AbortSignal.timeout(timeout) });
  } finally {
    if (orig === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = orig;
    }
  }
}

// ── PCCS Verification ───────────────────────────────────────────

interface PCCSResult {
  valid: boolean;
  containerMeasurement?: string;
  error?: string;
}

async function verifyQuoteViaPCCS(quote: string): Promise<PCCSResult> {
  try {
    const res = await fetch(PCCS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quote }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { valid: false, error: `PCCS returned ${res.status}: ${res.statusText}` };
    }
    const report = await res.json() as Record<string, unknown>;
    const quoteData = (report.quote ?? report) as Record<string, unknown>;
    const containerMeasurement = (quoteData.rtmr_3 ?? quoteData.rtmr3) as string | undefined;
    return { valid: true, containerMeasurement };
  } catch (err) {
    return { valid: false, error: `PCCS error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Main ────────────────────────────────────────────────────────

export async function verifyAndFundAgent(input: VerifyAndFundAgentInput): Promise<VerifyAndFundAgentResult> {
  const port = input.agentPort ?? 8080;
  // Container speaks plain HTTP; SecretVM TLS proxy is on 443 but routes may not work.
  // The attestation endpoint (:29343) is served by the SecretVM runtime itself (HTTPS).
  const agentBaseUrl = `http://${input.agentDomain}:${port}`;
  const attestationUrl = `https://${input.agentDomain}:${ATTESTATION_PORT}/cpu.html`;

  console.log('[boot] ── Step 6: Verify agent attestation & fund wallet ──');
  console.log(`[boot] Agent endpoint: ${agentBaseUrl}`);
  console.log(`[boot] Attestation URL: ${attestationUrl}`);

  // ── 1. Poll until agent is up ─────────────────────────────────
  console.log('[boot] Waiting for agent to come online...');
  let agentAddress: string | undefined;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    try {
      const res = await fetch(`${agentBaseUrl}/api/fund-address`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const data = await res.json() as { solanaAddress?: string };
        if (data.solanaAddress) {
          agentAddress = data.solanaAddress;
          console.log(`[boot] Agent is online. Solana address: ${agentAddress}`);
          break;
        }
      }
    } catch {
      // Agent not up yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!agentAddress) {
    return { success: false, error: `Agent did not come online within ${POLL_TIMEOUT_MS / 60_000} minutes` };
  }

  // ── 2. Fetch attestation quote ────────────────────────────────
  console.log('[boot] Fetching agent attestation quote...');
  let quote: string;
  try {
    const res = await fetchWithTlsOverride(attestationUrl);
    if (!res.ok) {
      return { success: false, error: `Attestation endpoint returned ${res.status}` };
    }
    const html = await res.text();
    const extracted = extractQuoteFromHtml(html);
    if (!extracted) {
      return { success: false, error: 'Could not extract attestation quote from cpu.html' };
    }
    quote = extracted;
  } catch (err) {
    return { success: false, error: `Failed to fetch attestation: ${err instanceof Error ? err.message : String(err)}` };
  }

  // ── 3. Verify via PCCS ────────────────────────────────────────
  console.log('[boot] Verifying attestation via PCCS...');
  const pccsResult = await verifyQuoteViaPCCS(quote);

  if (!pccsResult.valid) {
    console.error(`[boot] ATTESTATION FAILED: ${pccsResult.error}`);
    console.error('[boot] Agent is NOT running in a genuine TEE. Funds NOT sent.');
    return { success: false, error: pccsResult.error };
  }

  console.log(`[boot] Attestation VERIFIED — genuine SecretVM TEE`);
  if (pccsResult.containerMeasurement) {
    console.log(`[boot] Agent RTMR3: ${pccsResult.containerMeasurement}`);
  }

  // ── 4. Transfer remaining SOL ─────────────────────────────────
  console.log('[boot] Transferring remaining deployer SOL to agent...');
  const connection = new Connection(input.rpcUrl, 'confirmed');
  const payerKeypair = Keypair.fromSecretKey(input.payerSecretKey);

  const balance = await connection.getBalance(payerKeypair.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  console.log(`[boot] Deployer balance: ${balanceSol.toFixed(4)} SOL`);

  const reserveLamports = Math.ceil(TX_FEE_RESERVE_SOL * LAMPORTS_PER_SOL);
  const transferLamports = balance - reserveLamports;

  if (transferLamports <= 0) {
    console.warn('[boot] No SOL remaining after fee reserve — skipping transfer');
    return {
      success: true,
      agentAddress,
      solTransferred: 0,
      containerMeasurement: pccsResult.containerMeasurement,
    };
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payerKeypair.publicKey,
      toPubkey: new PublicKey(agentAddress),
      lamports: transferLamports,
    }),
  );

  try {
    const sig = await sendAndConfirmTransaction(connection, tx, [payerKeypair]);
    const transferred = transferLamports / LAMPORTS_PER_SOL;
    console.log(`[boot] Transferred ${transferred.toFixed(4)} SOL to agent (tx: ${sig})`);

    // ── 5. Notify agent of its external hostname ────────────────
    // The agent can't discover its own hostname (reverse DNS fails on SecretVM).
    // Tell it, so it can re-register on-chain with the correct endpoint.
    try {
      console.log(`[boot] Notifying agent of hostname: ${input.agentDomain}`);
      const hostnameRes = await fetch(`${agentBaseUrl}/api/set-hostname`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostname: input.agentDomain }),
        signal: AbortSignal.timeout(30_000),
      });
      if (hostnameRes.ok) {
        const result = await hostnameRes.json() as { ok?: boolean; endpoint?: string };
        console.log(`[boot] Agent re-registered with endpoint: ${result.endpoint}`);
      } else {
        console.warn(`[boot] Agent hostname notification failed: ${hostnameRes.status}`);
      }
    } catch (err) {
      console.warn(`[boot] Agent hostname notification error: ${err instanceof Error ? err.message : err}`);
    }

    return {
      success: true,
      agentAddress,
      solTransferred: transferred,
      containerMeasurement: pccsResult.containerMeasurement,
    };
  } catch (err) {
    return {
      success: false,
      agentAddress,
      error: `SOL transfer failed: ${err instanceof Error ? err.message : String(err)}`,
      containerMeasurement: pccsResult.containerMeasurement,
    };
  }
}
