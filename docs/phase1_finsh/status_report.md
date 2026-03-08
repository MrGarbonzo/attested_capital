# Attested Capital — Status Report

**Date:** 2026-03-01
**Repos:** `guardian-network`, `panthers-fund`
**VMs:** Agent (67.215.13.107), Guardian (67.43.239.6)

---

## What We Built

### 1. Guardian Network (`guardian-network`)

A TEE-secured governance node that manages agent registration, heartbeat monitoring, and encrypted DB backup storage.

- **Express API server** with routes for:
  - `GET /ping` — health check, returns guardian address
  - `POST /api/attestation` — TEE attestation verification + vault key exchange
  - `POST /api/db/snapshot` — receives encrypted DB snapshots from the agent
  - `POST /api/peers` — agent registration
  - Signed envelope middleware (ed25519 signature verification)
- **Sentry governance** — single-sentry mode auto-approves agent registrations
- **Agent lifecycle management** — registration, heartbeat monitoring (deactivates agents after 5 min of missed heartbeats), takeover support for agent rotation
- **Trust store** — tracks trusted peers (agents + other guardians) by ed25519 pubkey
- **DB snapshot receiver** — stores encrypted blobs with sequence number tracking
- **External endpoint config** — `GUARDIAN_EXTERNAL_ENDPOINT` env var so guardians announce routable addresses (not `0.0.0.0`)

### 2. Panthers Fund Agent (`panthers-fund`)

An autonomous trading agent running in a SecretVM TEE that manages an NFT-based investment fund.

- **45 registered tools** across 9 categories:
  - **Fund** — get/set state, verify invariants, pause/unpause
  - **NFT Accounts** — create, list, add funds (1 per Telegram user, max 500)
  - **Trades** — record trades, history, allocations, daily stats, open positions
  - **Wallet** — multi-chain addresses (Solana, Secret, Ethereum, Base)
  - **Balances** — live portfolio, snapshots, history
  - **Strategies** — 10 hardcoded strategies (EMA crossover, RSI, Bollinger, DCA, HODL, Supertrend, MACD, multi-timeframe, scalping, breakout)
  - **Sales** — dynamic NFT pricing, flash auctions, offer evaluation
  - **P2P Marketplace** — list/buy/cancel NFTs between users, 0% fee
  - **Withdrawals** — all-or-nothing exit, 2% fee distributed to remaining holders
  - **Guardian** — discover, list, health check, DB sync, broadcast
  - **Jupiter** — swap quotes and execution on Solana
- **Trading engine** — 4-hour cycle: pre-checks → fetch candles (CoinGecko) → run strategy → execute Jupiter swap → record trade → distribute P&L → verify invariants
- **Telegram bot** (grammy) — LLM-powered tool-calling interface via SecretAI (OpenAI-compatible API)
- **Guardian discovery** — Telegram protocol messages + `BOOTSTRAP_GUARDIANS` HTTP fallback (bots can't see each other's messages in groups)
- **Attestation verification** — agent verifies guardian TEEs by fetching `:29343/cpu.html` quote → PCCS verification → MRTD check
- **VaultClient** — AES-256-GCM encryption, signed envelopes, sequence-numbered snapshots
- **Cron jobs:**
  - Balance snapshot (hourly at :30)
  - Health check / invariants (every 10 min)
  - Trading cycle (every 4 hours)
  - Encrypted DB sync to guardians (hourly at :00)

### 3. New Tools Added This Session

- **`trigger_db_sync`** — manually trigger encrypted DB snapshot to all guardians (instead of waiting for hourly cron)
- **`simulate_trade`** — record a trade with specified P&L for testing, distributes profit/loss proportionally to all active NFT holders

---

## What We Tested

### Deployment (both VMs)
- Tar + SCP deployment (rsync not available on SecretVM Alpine)
- Docker multi-stage builds (builder + production)
- Both containers running with health checks

### Full Startup Flow (verified in logs)
1. Context initialized, wallet addresses generated
2. TEE signer initialized (production mode)
3. TEE identity established
4. Vault key generated (first deployment)
5. 45 tools registered
6. Telegram bot polling started
7. Bootstrap discovered guardian-1 via HTTP /ping
8. Guardian attestation verified (HTTPS :29343/cpu.html → PCCS)
9. Agent registration — takeover successful
10. Heartbeat started (60s interval)
11. All 4 cron jobs scheduled

### Trading Engine
- Set EMA Crossover strategy (`fastPeriod:9, slowPeriod:21, signalPeriod:9`)
- Trading cycle detected **golden cross** (buy signal, 15% of pool)
- Jupiter swap returned 401 (expected — no valid API key on devnet)
- Strategy logic confirmed working

### Simulated Trade (P&L Distribution)
- $50 position with $7.50 profit
- Distributed proportionally across 5 NFT holders:

| NFT | Owner | Deposit | After Trade | P&L | Share |
|-----|-------|---------|-------------|-----|-------|
| #1  | Alice | $100    | $102        | +$2 | 13.3% |
| #2  | Bob   | $150    | $153        | +$3 | 20.0% |
| #3  | Carol | $200    | $204        | +$4 | 26.7% |
| #4  | Dave  | $50     | $51         | +$1 | 6.7%  |
| #5  | Eve   | $250    | $255        | +$5 | 33.3% |

- Pool balance: $750 → $765

### Guardian Registration + Heartbeat
- Auto-approved in single-sentry mode
- Heartbeat timeout deactivation confirmed (325s)
- Takeover mechanism works (new agent replaces deactivated one)

### Attestation Verification
- Agent fetches HTTPS quote from guardian's SecretVM `:29343/cpu.html`
- Self-signed TLS cert handled (temporarily disables verification, MITM detectable via report_data)
- PCCS verification passes
- `APPROVED_MEASUREMENTS` check works (currently empty = accept all)

---

## Known Issues

### 1. SecretAI LLM Backend Down (Telegram bot unresponsive)
- **Symptom:** Bot receives messages but LLM calls return 500 / timeout
- **Root cause:** SecretAI gateway is up (401 in 17ms without auth) but the inference backend hangs indefinitely on authenticated requests
- **Impact:** Telegram bot cannot respond to user messages
- **Mitigation applied:** Added 60s timeout to LLM fetch so bot returns error message instead of hanging forever
- **Fix needed:** Wait for SecretAI to recover, or switch to alternative LLM endpoint

### 2. TEE Identity Changes on Container Restart
- Each `docker compose down/up` cycle generates a new TEE identity
- Causes CONFLICT with previously registered agent until heartbeat timeout (5 min)
- Not a bug — by design for TEE security — but means restarts require ~5 min wait

### 3. Jupiter Swap Auth
- Jupiter API returns 401 — need valid `JUPITER_API_KEY` for real trading
- Currently on devnet Solana RPC

### 4. DB Sync Not Yet Verified End-to-End
- `trigger_db_sync` tool works but requires running agent's VaultClient (in-process only)
- Ad-hoc scripts can't access the vault key (generated fresh each container start)
- Needs to be tested via Telegram bot (once LLM is back) or by waiting for hourly cron

---

## Current Environment

### Agent VM (67.215.13.107)
- SSH: `~/.ssh/secretvm_key`
- Deploy path: `/mnt/secure/docker_wd/`
- Code: `/mnt/secure/docker_wd/usr/`
- Env: `/mnt/secure/docker_wd/usr/.env`
- Container: `docker_wd-panthers-agent-1`
- DB: `/data/panthers.db` (inside container, `panthers-data` volume)

### Guardian VM (67.43.239.6)
- SSH: `~/.ssh/guardian_vm_key`
- Deploy path: `/mnt/secure/guardian/`
- Env: `/mnt/secure/guardian/.env`
- Container: `panthers-guardian`
- Key env: `GUARDIAN_EXTERNAL_ENDPOINT=http://67.43.239.6:3100`

### Agent Env Vars
- `BOOTSTRAP_GUARDIANS=http://67.43.239.6:3100`
- `APPROVED_MEASUREMENTS=` (empty = accept all)
- `SOLANA_RPC_URL` = devnet
- `SECRET_AI_BASE_URL=https://secretai-rytn.scrtlabs.com:21434/v1`
- `SECRET_AI_MODEL=qwen3:8b`

---

## Next Steps

### Immediate (blocked on SecretAI)
1. **Fix Telegram bot** — once SecretAI is back, test full conversational flow (ask for fund status, trigger trades, DB sync via chat)
2. **Test DB sync end-to-end** — trigger via Telegram or wait for cron, verify guardian receives and stores snapshot

### Short Term
3. **Real trading setup** — add valid Jupiter API key, switch to mainnet Solana RPC, fund the agent wallet with SOL + USDC
4. **Set APPROVED_MEASUREMENTS** — get the guardian's MRTD hash and lock it down (currently accepts any attestation)
5. **Profit distribution flow** — test `preview_withdrawal` and `execute_withdrawal` (2% fee to remaining holders)
6. **P2P marketplace** — test listing and purchasing NFTs between users
7. **LLM fallback** — add secondary LLM endpoint so bot doesn't go dark when SecretAI is down

### Medium Term
8. **Multi-guardian** — deploy 2nd guardian, test discovery + registration with multiple guardians
9. **DB sync recovery** — test agent recovery (pull latest snapshot from guardian on fresh start)
10. **Vault key persistence** — persist vault key so it survives container restarts (currently regenerated each time, breaking DB sync continuity)
11. **On-chain NFT minting** — bridge the off-chain ledger to actual Solana NFTs
12. **Monitoring dashboard** — expose metrics (trade count, P&L, heartbeat status, sync status)
