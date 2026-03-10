import { createServer } from 'node:http';
import { initContext } from './context.js';
import { buildTools } from './tools.js';
import { NFTMinter } from '../nft/minter.js';
import { createBot, sendAlert } from './telegram.js';
import { startCronJobs } from './cron.js';
import { createTEESigner } from './tee-signing.js';
import { getTEEInstanceId } from './tee.js';
import { runRegistrationFlow } from './registration.js';
import { VaultClient } from './vault-client.js';
import { createHeartbeatManager } from './heartbeat.js';
import { verifyGuardianAttestation, verifyQuoteViaPCCS } from './guardian-verifier.js';
import { aesEncrypt } from './tee-signing.js';
import { SolanaRegistryClient } from '../registry/solana-registry-client.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { existsSync, readFileSync } from 'node:fs';
import { ResilientLLM } from './resilient-llm.js';
import { VaultKeyManager } from '../vault/key-manager.js';
import { handleConfigRequest } from './config-api.js';
import { createStakingClient } from './staking-client.js';
import { unsealConfig } from './unseal-config.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

/** Discover public hostname from AGENT_EXTERNAL_HOST env, SecretVM system_info.json, or fallback. */
function discoverHostname(): string {
  const envHost = process.env.AGENT_EXTERNAL_HOST;
  if (envHost) return envHost;

  // SecretVM writes system info with the VM domain
  const systemInfoPath = '/mnt/secure/system_info.json';
  if (existsSync(systemInfoPath)) {
    try {
      const info = JSON.parse(readFileSync(systemInfoPath, 'utf-8')) as Record<string, unknown>;
      const domain = info.vmDomain ?? info.vm_domain ?? info.domain;
      if (typeof domain === 'string' && domain.length > 0) {
        console.log(`[panthers-fund] Auto-discovered hostname: ${domain}`);
        return domain;
      }
    } catch { /* fall through */ }
  }

  return 'localhost';
}

async function main() {
  // Unseal boot-agent config before reading env vars
  unsealConfig();

  console.log('[panthers-fund] Starting agent...');

  // ── Initialize service context ──────────────────────────────
  const ctx = initContext({
    dbPath: process.env.PANTHERS_DB_PATH ?? '/data/panthers.db',
    solanaRpcUrl: requireEnv('SOLANA_RPC_URL'),
    jupiterApiKey: process.env.JUPITER_API_KEY,
  });

  console.log('[panthers-fund] Context initialized, wallet addresses:', ctx.wallet.addresses);

  // ── Start HTTP status server (for guardian health checks) ─────
  const statusPort = Number(process.env.STATUS_PORT) || 8080;
  const server = createServer((req, res) => {
    // Try governance config routes first
    if (handleConfigRequest(req, res, { db: ctx.db })) return;

    if (req.method === 'GET' && req.url === '/status') {
      try {
        const state = ctx.db.getFundState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          total_pool_balance: state.total_pool_balance,
          total_nfts_active: state.total_nfts_active,
          active_strategy: state.active_strategy,
          is_paused: state.is_paused,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'GET' && req.url?.startsWith('/nft/')) {
      try {
        const tokenId = Number(req.url.split('/')[2]);
        if (!tokenId || isNaN(tokenId)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid token_id' }));
          return;
        }
        const account = ctx.db.getNFTAccount(tokenId);
        if (!account) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          token_id: account.token_id,
          owner_telegram_id: account.owner_telegram_id,
          current_balance: account.current_balance,
          is_active: account.is_active,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'GET' && req.url?.startsWith('/nfts/owner/')) {
      try {
        const telegramId = req.url.split('/')[3];
        if (!telegramId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing telegramId' }));
          return;
        }
        const accounts = ctx.db.getNFTsByOwner(telegramId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accounts.map(a => ({
          token_id: a.token_id,
          owner_telegram_id: a.owner_telegram_id,
          current_balance: a.current_balance,
          is_active: a.is_active,
        }))));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'POST' && req.url === '/api/backup/register') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { id, endpoint } = JSON.parse(body) as { id: string; endpoint: string };
          if (!id || !endpoint) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing id or endpoint' }));
            return;
          }
          const position = ctx.db.registerBackupAgent(id, endpoint);
          console.log(`[panthers-fund] Backup agent registered: ${id.substring(0, 16)}... at position ${position}`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, position }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    } else if (req.method === 'POST' && req.url === '/api/backup/heartbeat') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const { id, endpoint } = JSON.parse(body) as { id: string; endpoint?: string };
          if (!id) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'missing id' }));
            return;
          }
          const updated = ctx.db.backupAgentHeartbeat(id, endpoint);
          if (!updated) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'backup agent not found — register first' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'internal error' }));
        }
      });
    } else if (req.method === 'GET' && req.url === '/api/backup/list') {
      try {
        const backups = ctx.db.getBackupAgents();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ backups }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } else if (req.method === 'POST' && req.url === '/api/attestation') {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          if (!signer || !vaultClient) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'TEE signer or vault not initialized' }));
            return;
          }

          const vaultKey = vaultClient.getVaultKey();
          if (!vaultKey) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Vault key not available' }));
            return;
          }

          const {
            ed25519Pubkey: reqEd25519Pubkey,
            attestationQuote,
            x25519Pubkey,
            x25519Signature,
            senderId,
          } = JSON.parse(body) as {
            ed25519Pubkey: string;
            attestationQuote: string;
            x25519Pubkey: string;
            x25519Signature: string;
            senderId: string;
          };

          if (!attestationQuote || !x25519Pubkey || !reqEd25519Pubkey) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Missing required fields' }));
            return;
          }

          // Verify attestation quote via PCCS
          const pccsResult = await verifyQuoteViaPCCS(attestationQuote);
          if (!pccsResult.valid) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: `Attestation failed: ${pccsResult.error}` }));
            return;
          }

          // Check RTMR3 against approved measurements
          if (approvedMeasurements.size > 0) {
            // Measurements locked — enforce strict match
            if (!pccsResult.containerMeasurement || !approvedMeasurements.has(pccsResult.containerMeasurement)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: `Container measurement not approved: ${pccsResult.containerMeasurement ?? 'missing'}`,
              }));
              return;
            }
          } else {
            // First-guardian auto-enrollment: no measurements configured yet.
            // Accept this guardian and lock to its measurement for all future connections.
            if (!pccsResult.containerMeasurement) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                success: false,
                error: 'First guardian must provide a container measurement to auto-enroll',
              }));
              return;
            }
            approvedMeasurements.add(pccsResult.containerMeasurement);
            console.log(`[panthers-fund] First-guardian auto-enrollment: locked to measurement ${pccsResult.containerMeasurement}`);
          }

          // Verify X25519 pubkey signature (proves same TEE owns both keys)
          const x25519SigValid = signer.verify(
            Buffer.from(x25519Pubkey),
            x25519Signature,
            reqEd25519Pubkey,
          );
          if (!x25519SigValid) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'X25519 pubkey signature invalid' }));
            return;
          }

          // Wrap vault key using ECDH shared secret + AES-256-GCM
          const sharedSecret = signer.ecdh(x25519Pubkey);
          const encrypted = aesEncrypt(sharedSecret, vaultKey);
          const signPayload = `${encrypted.ciphertext}|${encrypted.iv}|${encrypted.authTag}`;
          const signature = await signer.sign(signPayload);

          console.log(`[panthers-fund] Vault key shared with ${senderId ?? 'unknown'} via attestation`);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            wrappedVaultKey: {
              encryptedVaultKey: encrypted.ciphertext,
              iv: encrypted.iv,
              authTag: encrypted.authTag,
              senderX25519Pubkey: signer.x25519PubkeyBase64,
              signature,
            },
            senderEd25519Pubkey: signer.ed25519PubkeyBase64,
          }));
        } catch (err) {
          console.error('[panthers-fund] Attestation endpoint error:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Internal error' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(statusPort, () => {
    console.log(`[panthers-fund] Status server listening on port ${statusPort}`);
  });

  // ── Initialize NFTMinter (cNFT minting) ───────────────────────
  const mockNft = process.env.MOCK_NFT === 'true';
  if (mockNft) {
    console.log('[panthers-fund] MOCK_NFT=true — skipping on-chain NFT minting, DB-only mode');
  } else {
    try {
      const minter = new NFTMinter(
        requireEnv('SOLANA_RPC_URL'),
        ctx.wallet.getSolanaKeypair(),
      );

      // Load existing collection config from DB if available
      const collectionConfig = ctx.db.getNFTCollectionConfig();
      if (collectionConfig) {
        minter.loadConfig(collectionConfig.collection_address, collectionConfig.merkle_tree_address);
        console.log('[panthers-fund] NFTMinter loaded with existing collection config');
      } else {
        console.log('[panthers-fund] NFTMinter initialized (no collection config yet — run setup_nft_collection)');
      }

      ctx.nftMinter = minter;
    } catch (err) {
      console.warn(`[panthers-fund] NFTMinter init failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Guardian discovery config ───────────────────────────────
  const groupChatIdStr = process.env.TELEGRAM_GROUP_CHAT_ID;
  if (groupChatIdStr) {
    ctx.groupChatId = Number(groupChatIdStr);
    console.log(`[panthers-fund] Guardian group chat ID: ${ctx.groupChatId}`);
  }

  // ── TEE Signing + Identity + VaultClient (before bot) ───────
  let signer: Awaited<ReturnType<typeof createTEESigner>> | undefined;
  let teeIdentity: Awaited<ReturnType<typeof getTEEInstanceId>> | undefined;
  let vaultClient: VaultClient | undefined;
  const vaultKeyHex = process.env.VAULT_KEY;

  try {
    signer = await createTEESigner();
    console.log(`[panthers-fund] TEE signer initialized (production: ${signer.isProduction})`);

    teeIdentity = await getTEEInstanceId();
    console.log(`[panthers-fund] TEE identity: ${teeIdentity.instanceId} (TDX: ${teeIdentity.isTDX})`);

    vaultClient = new VaultClient({
      nodeId: teeIdentity.instanceId,
      signer,
    });

    // Vault key: use VaultKeyManager for persistent key across restarts
    const keyManager = new VaultKeyManager(teeIdentity.instanceId, teeIdentity.codeHash);
    const vaultKey = keyManager.initialize(process.env.VAULT_KEY);
    vaultClient.setVaultKey(vaultKey);
  } catch (err) {
    console.warn(`[panthers-fund] TEE init failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }

  // ── Staking client ────────────────────────────────────────────
  const stakingClient = createStakingClient();

  // ── Build tool registry (after VaultClient so DB sync tool works) ──
  const dbPath = process.env.PANTHERS_DB_PATH ?? '/data/panthers.db';
  const botHolder: { bot?: ReturnType<typeof createBot> } = {};
  const tools = buildTools(ctx, {
    vaultClient,
    discoveredGuardians: ctx.discoveredGuardians,
    dbPath,
    botHolder,
    stakingClient,
    signer,
  });
  console.log(`[panthers-fund] ${tools.length} tools registered`);

  // ── Create Resilient LLM client ────────────────────────────
  const llm = new ResilientLLM({
    baseUrl: process.env.SECRET_AI_BASE_URL ?? 'https://secretai-rytn.scrtlabs.com:21434/v1',
    apiKey: requireEnv('SECRET_AI_API_KEY'),
    model: process.env.SECRET_AI_MODEL ?? 'qwen3:8b',
  });

  // ── Create Sentiment LLM client (DeepSeek for sentiment analysis) ──
  const sentimentLlm = new ResilientLLM({
    baseUrl: process.env.SECRET_AI_BASE_URL ?? 'https://secretai-rytn.scrtlabs.com:21434/v1',
    apiKey: requireEnv('SECRET_AI_API_KEY'),
    model: process.env.SENTIMENT_AI_MODEL ?? 'deepseek-r1:70b',
    maxRetries: 2,
    baseDelayMs: 3000,
    circuitThreshold: 3,
    circuitCooldownMs: 120_000,
  });
  ctx.sentimentLlm = sentimentLlm;

  // ── Create Telegram bot ─────────────────────────────────────
  const botToken = requireEnv('TELEGRAM_BOT_TOKEN');
  const allowedUsers = process.env.TELEGRAM_ALLOWED_USERS?.split(',').filter(Boolean);

  // Build a map of tools available in degraded mode (no LLM needed)
  const degradedTools = new Map(tools.filter(t =>
    ['get_fund_state', 'get_trade_history'].includes(t.name),
  ).map(t => [t.name, t]));

  const bot = createBot(tools, {
    botToken,
    allowedUsers,
    groupChatId: ctx.groupChatId,
    discoveredGuardians: ctx.discoveredGuardians,
    llm,
    degradedTools,
  });
  botHolder.bot = bot;

  // ── Start bot polling (non-blocking) ────────────────────────
  const botReady = new Promise<void>(resolve => {
    bot.start({
      onStart: () => {
        console.log('[panthers-fund] Telegram bot started polling');
        resolve();
      },
    });
  });
  await botReady;

  // ── Discover guardians from Solana registry ─────────────────
  const registryProgramIdStr = process.env.REGISTRY_PROGRAM_ID;
  let registryClient: SolanaRegistryClient | undefined;
  const registeredOnChain: { value: boolean } = { value: false };

  if (registryProgramIdStr) {
    const registryProgramId = new PublicKey(registryProgramIdStr);
    const solanaConnection = new Connection(requireEnv('SOLANA_RPC_URL'), 'confirmed');
    const agentKeypair = ctx.wallet.getSolanaKeypair();

    registryClient = new SolanaRegistryClient(
      solanaConnection,
      agentKeypair,
      registryProgramId,
    );

    // Register self in registry
    if (teeIdentity) {
      try {
        await registryClient.registerSelf({
          entityType: 'agent',
          endpoint: `https://${discoverHostname()}:${statusPort}`,
          teeInstanceId: teeIdentity.instanceId,
          codeHash: teeIdentity.codeHash,
          attestationHash: '',
          ed25519Pubkey: signer?.ed25519PubkeyBase64 ?? '',
          isActive: true,
        });
        registeredOnChain.value = true;
        console.log('[panthers-fund] Registered in Solana discovery registry');
      } catch (err) {
        console.warn(`[panthers-fund] Registry self-registration failed (will retry via cron): ${err instanceof Error ? err.message : err}`);
      }
    }

    // Discover guardians from registry
    try {
      const guardianEntries = await registryClient.getGuardians();
      for (const entry of guardianEntries) {
        if (!entry.isActive) continue;
        const now = Date.now();
        ctx.discoveredGuardians.set(entry.teeInstanceId, {
          address: entry.teeInstanceId,
          endpoint: entry.endpoint,
          isSentry: true,
          discoveredAt: now,
          lastSeen: now,
          verified: false,
        });
        console.log(`[panthers-fund] Discovered guardian: ${entry.teeInstanceId} at ${entry.endpoint}`);
      }
    } catch (err) {
      console.warn(`[panthers-fund] Registry discovery failed: ${err instanceof Error ? err.message : err}`);
    }

    console.log(`[panthers-fund] Discovered ${ctx.discoveredGuardians.size} guardian(s) from Solana registry`);
  } else {
    console.log('[panthers-fund] REGISTRY_PROGRAM_ID not set — Solana discovery disabled');
  }

  // ── Fallback: BOOTSTRAP_GUARDIANS direct HTTP ping ──────────
  // When Solana registry isn't available or returned no results, try direct endpoints.
  const bootstrapEndpoints = (process.env.BOOTSTRAP_GUARDIANS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (bootstrapEndpoints.length > 0 && ctx.discoveredGuardians.size === 0) {
    for (const endpoint of bootstrapEndpoints) {
      try {
        const res = await fetch(`${endpoint.replace(/\/$/, '')}/ping`, { signal: AbortSignal.timeout(5_000) });
        const data = await res.json() as { guardian?: string; status?: string };
        if (data.status === 'ok' && data.guardian) {
          const address = data.guardian;
          if (!ctx.discoveredGuardians.has(address)) {
            const now = Date.now();
            ctx.discoveredGuardians.set(address, {
              address,
              endpoint: endpoint.replace(/\/$/, ''),
              isSentry: true,
              discoveredAt: now,
              lastSeen: now,
              verified: false,
            });
            console.log(`[panthers-fund] Bootstrap discovered: ${address} at ${endpoint}`);
          }
        }
      } catch (err) {
        console.warn(`[panthers-fund] Bootstrap ping failed for ${endpoint}: ${err instanceof Error ? err.message : err}`);
      }
    }
    console.log(`[panthers-fund] Bootstrap discovered ${ctx.discoveredGuardians.size} guardian(s)`);
  }

  // ── Verify guardian attestations ────────────────────────────
  const approvedMeasurements = new Set(
    (process.env.APPROVED_MEASUREMENTS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  );

  for (const [address, guardian] of ctx.discoveredGuardians) {
    console.log(`[panthers-fund] Verifying attestation for ${address} at ${guardian.endpoint}...`);
    const result = await verifyGuardianAttestation(guardian.endpoint, approvedMeasurements);

    if (result.valid) {
      guardian.verified = true;
      console.log(`[panthers-fund] Guardian ${address} attestation verified (measurement: ${result.codeMeasurement ?? 'n/a'})`);
    } else {
      console.warn(`[panthers-fund] Guardian ${address} attestation FAILED: ${result.error}`);
      ctx.discoveredGuardians.delete(address);
    }
  }

  console.log(`[panthers-fund] ${ctx.discoveredGuardians.size} verified guardian(s)`);

  // ── Registration + Heartbeat ────────────────────────────────
  if (signer && teeIdentity) {
    for (const [address, guardian] of ctx.discoveredGuardians) {
      try {
        // Registration
        const regResult = await runRegistrationFlow({
          guardianEndpoint: guardian.endpoint,
          signer,
        });
        console.log(`[panthers-fund] Registration with ${address}: ${regResult.status} — ${regResult.message}`);

        if (regResult.status === 'conflict') {
          console.error(`[panthers-fund] Agent conflict with ${address} — another agent is active`);
          continue;
        }

        // Heartbeat — use the teeIdentity from registration (the one actually registered)
        const heartbeat = createHeartbeatManager({
          guardianEndpoint: guardian.endpoint,
          teeIdentity: regResult.teeIdentity,
          signer,
          onDeactivation: (reason) => {
            console.error(`[panthers-fund] Deactivated by ${address}: ${reason}`);
          },
          onHeartbeat: (success, failures) => {
            if (!success) {
              console.warn(`[panthers-fund] Heartbeat to ${address} failed (${failures} consecutive)`);
            }
          },
        });
        heartbeat.start();
        console.log(`[panthers-fund] Heartbeat started for ${address}`);
      } catch (err) {
        console.warn(`[panthers-fund] Guardian ${address} setup failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // ── Start cron jobs ─────────────────────────────────────────
  const agentEndpoint = `https://${discoverHostname()}:${statusPort}`;
  startCronJobs(ctx, bot, {
    alertChatId: process.env.TELEGRAM_ALERT_CHAT_ID,
    vaultClient,
    discoveredGuardians: ctx.discoveredGuardians,
    groupChatId: ctx.groupChatId,
    dbPath,
    registryClient,
    agentEndpoint,
    teeInstanceId: teeIdentity?.instanceId,
    stakingClient,
    ed25519Pubkey: signer?.ed25519PubkeyBase64,
    codeHash: teeIdentity?.codeHash,
    registeredOnChain,
  });

  // ── Notify owner + group: agent is online ───────────────────
  const registryLine = registryProgramIdStr
    ? `Registry: ${registryProgramIdStr}`
    : 'Registry: not configured';
  const guardianCount = ctx.discoveredGuardians.size;
  const regStatus = registeredOnChain.value ? 'registered' : 'pending (will retry)';

  const solAddress = ctx.wallet.addresses.solana;

  const onlineMsg =
    `Panthers Fund Agent is online.\n\n` +
    `Solana: ${solAddress}\n` +
    `${registryLine}\n` +
    `On-chain: ${regStatus}\n` +
    `Guardians: ${guardianCount} verified\n` +
    `Endpoint: ${agentEndpoint}`;

  const alertChatId = process.env.TELEGRAM_ALERT_CHAT_ID;
  if (alertChatId) await sendAlert(bot, alertChatId, onlineMsg);
  if (ctx.groupChatId) await sendAlert(bot, String(ctx.groupChatId), onlineMsg);
}

main().catch((err) => {
  console.error('[panthers-fund] Fatal error:', err);
  process.exit(1);
});
