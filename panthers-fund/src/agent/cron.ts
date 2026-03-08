import { readFileSync } from 'fs';
import cron from 'node-cron';
import type { ServiceContext, DiscoveredGuardian } from './context.js';
import type { Bot } from 'grammy';
import { sendAlert } from './telegram.js';
import { runTradingCycle, type TradingCycleResult } from './trading-engine.js';
import { formatDbSyncSent } from './telegram-protocol.js';
import type { VaultClient } from './vault-client.js';
import { loadAttestationQuote } from './tee-signing.js';
import type { SolanaRegistryClient } from '../registry/solana-registry-client.js';
import type { StakingClient } from './staking-client.js';

interface CronConfig {
  /** Telegram chat ID to send alerts to. */
  alertChatId?: string;
  /** VaultClient for encrypted DB snapshots. */
  vaultClient?: VaultClient;
  /** Live map of discovered guardians. */
  discoveredGuardians?: Map<string, DiscoveredGuardian>;
  /** Telegram group chat ID for protocol messages. */
  groupChatId?: number;
  /** Path to the agent's SQLite database file. */
  dbPath?: string;
  /** Solana registry client for on-chain heartbeats. */
  registryClient?: SolanaRegistryClient;
  /** Agent's external endpoint URL for registry updates. */
  agentEndpoint?: string;
  /** TEE instance ID for encrypted registry fields. */
  teeInstanceId?: string;
  /** Staking client for syncing stake state from guardians. */
  stakingClient?: StakingClient;
  /** Ed25519 pubkey (base64) for registry self-registration retry. */
  ed25519Pubkey?: string;
  /** Code hash for registry self-registration retry. */
  codeHash?: string;
  /** Mutable flag: whether this agent is registered on-chain. */
  registeredOnChain?: { value: boolean };
}

export function startCronJobs(ctx: ServiceContext, bot: Bot, config: CronConfig): void {
  const alertChat = config.alertChatId;

  // ── Balance snapshot: every hour at :30 ──────────────────────
  cron.schedule('30 * * * *', async () => {
    console.log('[cron] Running balance snapshot...');
    try {
      await ctx.tracker.recordSnapshot();
      console.log('[cron] Balance snapshot recorded');
    } catch (err: unknown) {
      console.error('[cron] Balance snapshot failed:', err);
      if (alertChat) {
        await sendAlert(bot, alertChat, `Balance snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  // ── Health check: every 10 minutes ───────────────────────────
  cron.schedule('*/10 * * * *', async () => {
    console.log('[cron] Running health check...');
    try {
      ctx.db.verifyInvariants();
      console.log('[cron] Health check passed');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron] Invariants FAILED:', msg);
      if (alertChat) {
        await sendAlert(bot, alertChat, `ALERT: Invariants failed — ${msg}`);
      }
    }
  });

  // ── Trading cycle: every 4 hours ─────────────────────────────
  cron.schedule('0 */4 * * *', async () => {
    console.log('[cron] Starting trading cycle...');
    let result: TradingCycleResult;
    try {
      result = await runTradingCycle(ctx);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[cron] Trading cycle FAILED:', msg);
      if (alertChat) {
        await sendAlert(bot, alertChat, `TRADING ERROR: ${msg}`);
      }
      return;
    }

    console.log(`[cron] Trading cycle result: ${result.action} — ${result.reason}`);

    // Alert on trades or errors
    if (alertChat) {
      if (result.action === 'opened') {
        await sendAlert(bot, alertChat, `TRADE OPENED: ${result.reason}\nTx: ${result.signature ?? 'n/a'}`);
      } else if (result.action === 'closed') {
        const pnl = result.pnlCents ?? 0;
        const emoji = pnl >= 0 ? '+' : '';
        await sendAlert(bot, alertChat,
          `TRADE CLOSED: ${result.reason}\nP&L: ${emoji}${pnl} cents\nTx: ${result.signature ?? 'n/a'}`);
      } else if (result.action === 'error') {
        await sendAlert(bot, alertChat, `TRADING ERROR: ${result.reason}`);
      }
    }
  });

  // ── DB sync to guardians: every hour at :00 ───────────────────
  if (config.vaultClient?.hasVaultKey && config.discoveredGuardians && config.dbPath) {
    const vc = config.vaultClient;
    const guardians = config.discoveredGuardians;
    const dbPath = config.dbPath;

    cron.schedule('0 * * * *', async () => {
      console.log('[cron] Running DB sync...');
      try {
        const dbBuffer = readFileSync(dbPath);
        const attestationQuote = loadAttestationQuote() ?? undefined;
        const envelope = await vc.createSnapshot(dbBuffer, attestationQuote);
        let ok = 0;
        for (const [addr, g] of guardians) {
          try {
            const res = await fetch(`${g.endpoint.replace(/\/$/, '')}/api/db/snapshot`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(envelope),
              signal: AbortSignal.timeout(30_000),
            });
            const result = await res.json() as { accepted: boolean };
            if (result.accepted) ok++;
          } catch (err) {
            console.warn(`[cron] DB sync to ${addr} failed: ${err instanceof Error ? err.message : err}`);
          }
        }
        console.log(`[cron] DB sync complete: ${ok}/${guardians.size} guardians accepted`);

        // Send protocol message to Telegram group
        if (config.groupChatId && ok > 0) {
          await sendAlert(bot, String(config.groupChatId), formatDbSyncSent({
            seq: vc.currentSequence,
            peers: ok,
            sizeKB: Math.round(dbBuffer.length / 1024),
          }));
        }
      } catch (err) {
        console.error('[cron] DB sync failed:', err);
        if (alertChat) {
          await sendAlert(bot, alertChat, `DB sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    console.log('[cron] Scheduled: balance-snapshot (hourly), health-check (10min), trading-cycle (4h), db-sync (hourly)');
  } else {
    console.log('[cron] Scheduled: balance-snapshot (hourly), health-check (10min), trading-cycle (4h)');
    if (!config.vaultClient?.hasVaultKey) {
      console.log('[cron] DB sync skipped: no vault key');
    }
  }

  // ── Staking state sync from guardians: every hour at :45 ────
  if (config.stakingClient && config.discoveredGuardians) {
    const sc = config.stakingClient;
    const guardians = config.discoveredGuardians;

    cron.schedule('45 * * * *', async () => {
      console.log('[cron] Running staking state sync...');
      let totalSynced = 0;

      for (const [addr, g] of guardians) {
        if (!g.verified) continue;
        try {
          const { stakes } = await sc.getGuardianStakes(g.endpoint, addr);
          const activeTokenIds = new Set<number>();

          for (const stake of stakes) {
            // Only cache if the token exists in our local nft_accounts
            const localAcct = ctx.db.getNFTAccount(stake.token_id);
            if (!localAcct) continue;

            activeTokenIds.add(stake.token_id);
            ctx.db.upsertStakingState({
              token_id: stake.token_id,
              owner_tg_id: stake.owner_tg_id,
              guardian_address: addr,
              guardian_endpoint: g.endpoint,
              staked_at: stake.staked_at,
              stake_value_cents: stake.current_value,
              delegated_to: null,
              delegation_expires: null,
            });
            totalSynced++;
          }

          // Clear any cached states that are no longer active at this guardian
          const cached = ctx.db.getStakingStateByGuardian(addr);
          for (const c of cached) {
            if (!activeTokenIds.has(c.token_id)) {
              ctx.db.clearStakingState(c.token_id);
            }
          }
        } catch (err) {
          console.warn(`[cron] Staking sync from ${addr} failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      console.log(`[cron] Staking sync complete: ${totalSynced} stake(s) synced`);
    });
    console.log('[cron] Scheduled: staking-sync (hourly :45)');
  }

  // ── Registry heartbeat + re-discovery: every 5 minutes ──────
  if (config.registryClient) {
    const registry = config.registryClient;
    const guardians = config.discoveredGuardians;

    cron.schedule('*/5 * * * *', async () => {
      // Retry self-registration if not yet registered
      if (config.registeredOnChain && !config.registeredOnChain.value) {
        try {
          await registry.registerSelf({
            entityType: 'agent',
            endpoint: config.agentEndpoint ?? '',
            teeInstanceId: config.teeInstanceId ?? '',
            codeHash: config.codeHash ?? '',
            attestationHash: '',
            ed25519Pubkey: config.ed25519Pubkey ?? '',
            isActive: true,
          });
          config.registeredOnChain.value = true;
          console.log('[cron] Registry self-registration succeeded (retry)');
          return; // skip heartbeat this tick, next tick will heartbeat
        } catch (err) {
          console.warn(`[cron] Registry self-registration retry failed: ${err instanceof Error ? err.message : err}`);
          return; // no point in heartbeat/endpoint update if PDA doesn't exist
        }
      }

      // Heartbeat
      try {
        await registry.sendHeartbeat();
        console.log('[cron] Solana registry heartbeat sent');
      } catch (err) {
        console.warn(`[cron] Registry heartbeat failed: ${err instanceof Error ? err.message : err}`);
      }

      // Re-post endpoint (survives IP changes)
      if (config.agentEndpoint) {
        try {
          await registry.updateEndpoint(config.agentEndpoint);
          console.log('[cron] Solana registry endpoint updated');
        } catch (err) {
          console.warn(`[cron] Registry endpoint update failed: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Re-discover guardians (picks up new registrations)
      if (guardians) {
        try {
          const entries = await registry.getGuardians();
          let added = 0;
          for (const entry of entries) {
            if (!entry.isActive) continue;
            if (guardians.has(entry.teeInstanceId)) {
              // Update endpoint if changed
              const existing = guardians.get(entry.teeInstanceId)!;
              if (existing.endpoint !== entry.endpoint) {
                existing.endpoint = entry.endpoint;
                existing.lastSeen = Date.now();
              }
              continue;
            }
            guardians.set(entry.teeInstanceId, {
              address: entry.teeInstanceId,
              endpoint: entry.endpoint,
              isSentry: true,
              discoveredAt: Date.now(),
              lastSeen: Date.now(),
              verified: false, // Will be verified on next interaction
            });
            added++;
          }
          if (added > 0) {
            console.log(`[cron] Re-discovered ${added} new guardian(s) from registry`);
          }
        } catch (err) {
          console.warn(`[cron] Registry re-discovery failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    });
    console.log('[cron] Scheduled: registry-heartbeat + re-discovery (5min)');
  }
}
