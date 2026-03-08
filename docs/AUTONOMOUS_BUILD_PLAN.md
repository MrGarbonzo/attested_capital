# Panthers Fund — Autonomous Build Plan (v2)

**Goal:** Achieve a truly autonomous trading fund where no human holds credentials that can control the agent.

**Approach:** Build on the existing panthers-fund and guardian-network codebases. Add three new components: boot agent, Solana discovery registry, and config governance. Replace the broken Telegram-based agent-guardian protocol with on-chain discovery + HTTP.

---

## What Already Exists

Before building anything new, here's what's already working:

### Panthers Fund Agent (`panthers-fund/`)
- Trading engine with strategies, risk limits, Jupiter swaps on Solana
- NFT minting via Metaplex Bubblegum (compressed NFTs)
- P2P marketplace (listings, swaps, withdrawals with 2% fee redistribution)
- Database ledger with fund state, NFT accounts, trade history, balance tracking
- Telegram bot for buyer-facing sales (Grammy), scarcity-aware pricing + negotiation
- TEE signing via SecretVM (`src/agent/tee-signing.ts`), identity (`src/agent/tee.ts`)
- Guardian attestation verification via Intel PCCS (`src/agent/guardian-verifier.ts`)
- Registration flow with guardians (`src/agent/registration.ts`)
- Heartbeat manager sending 60s proofs of liveness (`src/agent/heartbeat.ts`)
- Vault client for encrypted DB snapshots (`src/agent/vault-client.ts`)
- Cron jobs: balance snapshots, health checks, trading cycles, DB sync
- `/status` HTTP endpoint on port 8080 (for guardian health checks)
- Resilient LLM client with retry + circuit breaker
- 55 tools available to the LLM for fund management
- **251 tests passing across 16 test files**

### Guardian Network (`guardian-network/`)
- Express API server with full route set (`src/api/server.ts`, `src/api/routes.ts`)
- Sentry governance: proposals, voting, delegations (`src/sentry/`)
- 7 proposal types: `code_update` (75%), `rpc_add` (50%), `rpc_remove` (50%), `strategy_change` (20%), `anomaly_resolution` (50%), `agent_registration` (75%), `vault_key_rotation` (75%)
- Agent registration with voting (`src/sentry/registration-voting.ts`)
- Agent heartbeat monitoring with auto-deactivation after 5min timeout
- Health monitor querying agent `/status` endpoint (`src/guardian/health-monitor.ts`)
- Backup storage for encrypted DB snapshots (`src/guardian/storage.ts`)
- Peer registry (`src/guardian/peers.ts`), delegation tracker (`src/guardian/delegations.ts`)
- RPC registry with automated testing and reputation (`src/guardian/rpc-registry.ts`)
- Trust store (in-memory) with nonce-based replay protection (`src/shared/trust-store.ts`)
- Signed envelope protocol: ed25519 signatures, timestamps, nonce tracking (`src/shared/signed-envelope.ts`)
- Attestation verification via PCCS (`src/shared/attestation-verifier.ts`)
- Vault key exchange via X25519 ECDH (`src/shared/vault.ts`)
- DB snapshot sync: AES-256-GCM encryption, sequence numbers, checksum validation (`src/guardian/db-sync.ts`)
- Telegram bot for guardian operators: `/vote`, `/status`, `/peers`, `/proposals`, `/delegate`
- Code review automation (`src/sentry/code-reviewer.ts`)
- Strategy governance with hot-reload (`src/sentry/strategy-governance.ts`)

### Currently Running
- Agent VM: `67.215.13.107` (SecretVM TEE)
- Guardian VM: `67.43.239.6` (SecretVM TEE)
- Agent registered with guardian, heartbeat active
- Health monitor querying `/status` endpoint

---

## What's Broken / Missing

### Problem 1: Telegram bot-to-bot communication is blocked
Telegram prevents bots from seeing each other's messages. The current agent-guardian discovery via Telegram group messages **does not work**. It only works today because `BOOTSTRAP_GUARDIANS` hardcodes the guardian's HTTP endpoint — defeating the purpose of discovery.

### Problem 2: Whoever holds the Telegram bot token controls the agent's communication
The bot token is created manually via @BotFather and passed as an env var. The fund operator knows the token and could impersonate the agent, inject prompts, or intercept buyer DMs. This breaks the "no human controls this fund" guarantee.

### Problem 3: No trustless discovery mechanism
Without Telegram, agents and guardians have no way to find each other without a human configuring endpoints.

### Problem 4: Configuration changes require SSH access
Changing RPC endpoints, API keys, or trading parameters requires SSH into the TEE and editing env vars. This gives humans direct access to the agent's runtime.

---

## What We're Building

Three new components, plus modifications to the existing projects:

```
attested_capital/
├── panthers-fund/           # EXISTING — modify discovery + config loading
├── guardian-network/        # EXISTING — add config governance DB
├── boot-agent/              # NEW — one-time autonomous Telegram setup
└── solana-registry/         # NEW — on-chain discovery program
```

---

## Phase 1: Solana Discovery Registry (New Anchor Program)

**Purpose:** Replace Telegram-based discovery with on-chain registration. Agents and guardians register their endpoints + attestation hashes on Solana. Anyone can read the registry to discover peers.

**Location:** `attested_capital/solana-registry/`

### Program Design

```rust
// PDA seeds: ["registry", entity_pubkey]
// One account per agent/guardian, derived from their Solana wallet

#[account]
pub struct RegistryEntry {
    pub entity_type: EntityType,       // Agent or Guardian
    pub endpoint: String,              // HTTPS URL (max 128 chars)
    pub tee_instance_id: [u8; 16],     // TEE hardware identity
    pub code_hash: [u8; 32],           // RTMR3 / mr_enclave
    pub attestation_hash: [u8; 32],    // Hash of latest attestation quote
    pub ed25519_pubkey: [u8; 32],      // For signed envelope verification
    pub registered_at: i64,            // Slot timestamp
    pub last_heartbeat: i64,           // Updated periodically
    pub is_active: bool,               // Can be deactivated
    pub bump: u8,                      // PDA bump seed
}

// Instructions:
// - register(entity_type, endpoint, tee_instance_id, code_hash, attestation_hash, ed25519_pubkey)
// - update_heartbeat()
// - update_endpoint(new_endpoint)
// - deactivate()
```

### Why Solana
- Agent already has a Solana wallet (`EipXWSyRPq1GN1k2Y2jdivxfyNMAjbmXWYeBMsy9htW4`)
- Already connected to Solana RPC (Helius devnet)
- Registration transaction is signed by the agent's wallet — binding on-chain identity to the fund wallet
- Publicly verifiable: anyone can read the registry and check attestation hashes
- No human intermediary for discovery

### Integration with Existing Code

**Agent side** (`panthers-fund/src/agent/index.ts`):
- Replace the Telegram discovery phase (lines 162-175) and bootstrap phase (lines 177-208) with:
  1. Register self in Solana registry on startup
  2. Query registry for guardian entries
  3. Continue with existing attestation verification + registration flow (lines 210-266 unchanged)

**Guardian side** (`guardian-network/src/guardian/main.ts`):
- Add Solana registry query on startup to discover the agent endpoint
- Replace hardcoded `FUND_MANAGER_ENDPOINT` with registry lookup
- Register self in the registry
- Periodically refresh registry entries

### Deliverable
- Anchor program deployed to Solana devnet
- TypeScript client library in `solana-registry/sdk/`
- Agent + guardian both use registry for discovery
- `BOOTSTRAP_GUARDIANS` env var removed
- `FUND_MANAGER_ENDPOINT` env var becomes optional (falls back to registry)

---

## Phase 2: Boot Agent (New Project)

**Purpose:** One-time process running inside a TEE that creates the agent's Telegram bot identity autonomously. No human ever sees the bot token.

**Location:** `attested_capital/boot-agent/`

### How It Works

```
┌──────────────────────────────────────────────────────────┐
│  TEE (SecretVM)                                           │
│                                                           │
│  ┌─────────────────┐         ┌─────────────────────────┐ │
│  │  Boot Agent      │────────>│  Sealed Config File     │ │
│  │  (GramJS/MTProto)│         │                         │ │
│  │                  │         │  bot_token: "7820..."    │ │
│  │  Uses Twilio to  │         │  group_id: "-100269..." │ │
│  │  get phone + SMS │         │  bot_username: "@pan..." │ │
│  │                  │         │                         │ │
│  │  Chats with      │         │  Encrypted with TEE     │ │
│  │  @BotFather      │         │  enclave key. Only      │ │
│  │                  │         │  attested code with      │ │
│  │  Creates group   │         │  matching code hash     │ │
│  │  Sets up admins  │         │  can read it.           │ │
│  │                  │         │                         │ │
│  │  Then exits.     │         └─────────────────────────┘ │
│  └─────────────────┘                    │                 │
│                                         │ reads           │
│                               ┌─────────▼───────────┐    │
│                               │  Fund Agent          │    │
│                               │  (Grammy bot)        │    │
│                               │  Starts with sealed  │    │
│                               │  token. Runs forever │    │
│                               └─────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

### Boot Sequence

1. Boot agent starts inside TEE
2. Calls Twilio API to provision a phone number (API key is the only external input)
3. Receives SMS verification code via Twilio webhook/polling
4. Uses GramJS (MTProto client library) to register a Telegram user account with that phone number
5. As that user, chats with @BotFather:
   - `/newbot` → enters bot name → receives bot token
6. Creates a Telegram supergroup
7. Adds the new bot to the group, promotes to admin
8. Invites the fund owner (by Telegram user ID, passed as env var) and makes them admin
9. Writes sealed config to TEE storage: `{ botToken, groupChatId, botUsername }`
10. Destroys the Telegram user session (phone number no longer needed)
11. Exits with status 0

### What the Fund Agent Changes

**`panthers-fund/src/agent/index.ts`** — modify startup to load config from sealed storage:

```typescript
// Currently:
const botToken = requireEnv('TELEGRAM_BOT_TOKEN');

// After:
const botToken = loadSealedConfig().botToken ?? process.env.TELEGRAM_BOT_TOKEN;
```

Backward compatible — if `TELEGRAM_BOT_TOKEN` env var exists (dev mode), use it. Otherwise, read from sealed config (production mode).

### Dependencies
```json
{
  "telegram": "^2.20.0",     // GramJS (MTProto client)
  "twilio": "^5.0.0"         // SMS API
}
```

### Security Properties
- Bot token created inside TEE, never leaves enclave
- Phone number session destroyed after bot creation
- Twilio API key cannot be used to control Telegram (blast radius limited to SMS costs)
- Attestation proves the code that created the token doesn't leak it
- Fund owner is invited to the group but never sees the bot token

### Open Questions
- Telegram may flag automated account creation. Mitigation: add natural delays, use a real phone number (not VOIP if Telegram blocks those).
- If TEE restarts and sealed config is lost, boot agent must run again. Mitigation: sealed storage persists across restarts on SecretVM.
- Which Twilio plan to use (pay-as-you-go is fine, ~$1 per phone number).

---

## Phase 3: Config Governance DB

**Purpose:** Guardians collectively control the agent's runtime configuration through governance proposals. The agent reads config from guardians instead of env vars. No SSH needed.

### Two-Database Architecture

```
Agent controls:                   Guardians control:
┌─────────────────────┐          ┌──────────────────────────┐
│  Finance DB          │          │  Config DB               │
│  (panthers.db)       │          │  (guardian.db)            │
│                      │          │                          │
│  fund_state          │          │  config_entries          │
│  nft_accounts        │          │  config_history          │
│  trades              │          │  proposals (existing)    │
│  trade_allocations   │          │  votes (existing)        │
│  marketplace_*       │          │  rpc_registry (existing) │
│  balance_snapshots   │          │                          │
│  strategy_config     │          │  New proposal types:     │
│                      │          │  - config_update (50%)   │
│  Agent writes.       │          │  - api_key_rotation (75%)│
│  Guardians back up.  │          │                          │
└─────────────────────┘          └──────────────────────────┘
```

### Guardian Schema Addition (`guardian-network/database/schema.sql`)

```sql
-- Add to existing schema

CREATE TABLE IF NOT EXISTS config_entries (
  key         TEXT PRIMARY KEY,           -- e.g. 'solana_rpc_url', 'ai_model'
  value       TEXT NOT NULL,              -- Current value (encrypted for secrets)
  category    TEXT NOT NULL,              -- 'rpc', 'api_key', 'ai', 'trading'
  is_secret   INTEGER NOT NULL DEFAULT 0, -- 1 = value is vault-encrypted
  updated_by  TEXT NOT NULL,              -- proposal ID that set this value
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL,
  old_value   TEXT,
  new_value   TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Update proposals table to accept new types:
```sql
-- Modify CHECK constraint to add: 'config_update', 'api_key_rotation'
```

### Proposal Thresholds

| Type | Threshold | Deadline | What it changes |
|------|-----------|----------|-----------------|
| `config_update` | 50% | 24h | RPC URLs, LCD endpoints, non-secret config |
| `api_key_rotation` | 75% | 4h | API keys (Jupiter, AI), encrypted values |
| Existing types | Unchanged | Unchanged | Already implemented |

### Config Flow

1. Guardian proposes: `POST /api/sentry/config/propose` with `{ key, value, category }`
2. Creates a `config_update` or `api_key_rotation` proposal (existing proposal system)
3. Guardians vote via existing `/vote` Telegram command or API
4. If passed, config entry is written to `config_entries` table
5. Agent polls guardian for latest config: `GET /api/config/current`
6. Agent applies config changes at runtime (where possible) or on next restart

### What the Agent Changes

Add a config sync cron job to `panthers-fund/src/agent/cron.ts`:
- Every 5 minutes, fetch `GET {guardianEndpoint}/api/config/current`
- Compare with current runtime config
- Apply non-disruptive changes immediately (RPC URL swap, model change)
- Queue disruptive changes for next restart (if any)
- Log all config changes

### Config Categories and Scope

| Category | Keys | Guardian-controlled? |
|----------|------|---------------------|
| `rpc` | `solana_rpc_url`, `secret_lcd_url` | Yes |
| `api_key` | `jupiter_api_key`, `secret_ai_api_key` | Yes (encrypted) |
| `ai` | `secret_ai_base_url`, `secret_ai_model` | Yes |
| `trading` | `max_position_pct`, `stop_loss_pct` | Yes (via `strategy_change`) |
| `telegram` | `telegram_bot_token` | No — sealed to TEE |
| `wallet` | Private keys, mnemonics | No — sealed to TEE, never accessible |

---

## Phase 4: Integration — Wire It All Together

### Agent Startup (Revised)

```
1. Load sealed config (bot token, group ID)       ← NEW (Phase 2)
   └─ Fallback to env vars in dev mode

2. Initialize service context (DB, wallet, Jupiter, balance tracker)
   └─ EXISTING (unchanged)

3. Start /status HTTP server on port 8080
   └─ EXISTING (just added)

4. Initialize TEE signer + identity
   └─ EXISTING (unchanged)

5. Register self in Solana discovery registry      ← NEW (Phase 1)
   └─ Write endpoint + attestation to PDA

6. Discover guardians from Solana registry          ← REPLACES Telegram discovery + BOOTSTRAP_GUARDIANS
   └─ Read all Guardian-type entries from registry

7. Verify guardian attestations via PCCS
   └─ EXISTING (unchanged)

8. Registration + heartbeat with verified guardians
   └─ EXISTING (unchanged)

9. Fetch initial config from guardians              ← NEW (Phase 3)
   └─ GET /api/config/current
   └─ Apply RPC URLs, API keys, AI model config

10. Build tool registry, create LLM client, start Telegram bot
    └─ EXISTING (unchanged, but using config from step 9)

11. Start cron jobs (including config sync every 5 min)
    └─ EXISTING + NEW config sync job
```

### Guardian Startup (Revised)

```
1-6. Initialize DB, TEE signer, trust store, modules
     └─ EXISTING (unchanged)

7.   Register self in Solana discovery registry     ← NEW (Phase 1)

8.   Discover agent from Solana registry            ← REPLACES hardcoded FUND_MANAGER_ENDPOINT
     └─ Read Agent-type entries from registry
     └─ Use endpoint for health checks

9.   Serve config API                               ← NEW (Phase 3)
     └─ GET /api/config/current
     └─ POST /api/sentry/config/propose

10.  Start Telegram bot, background jobs
     └─ EXISTING (unchanged)
```

### Removed Env Vars (No Longer Needed)
- `BOOTSTRAP_GUARDIANS` — replaced by Solana registry
- `FUND_MANAGER_ENDPOINT` — replaced by Solana registry lookup
- `TELEGRAM_GROUP_CHAT_ID` (on agent) — comes from sealed config
- `TELEGRAM_BOT_TOKEN` (on agent) — comes from sealed config
- `SOLANA_RPC_URL` (on agent) — comes from config governance (initial value from boot)
- `SECRET_AI_API_KEY` (on agent) — comes from config governance
- `JUPITER_API_KEY` (on agent) — comes from config governance

### Remaining Env Vars (Still Required)
- `PANTHERS_DB_PATH` — local path, not a secret
- `REGISTRY_PROGRAM_ID` — Solana program address (public, immutable)
- `APPROVED_MEASUREMENTS` — code hashes to trust (can also be governed)
- Guardian env vars — guardians still use env vars for their own config (they're the config controllers)

---

## Implementation Order

### Week 1-2: Solana Discovery Registry
1. `anchor init solana-registry`
2. Write program with `register`, `heartbeat`, `update_endpoint`, `deactivate`
3. Write TypeScript SDK client
4. Deploy to devnet
5. Write tests

### Week 3-4: Boot Agent
1. Set up `boot-agent/` project with GramJS + Twilio
2. Implement phone provisioning + SMS verification
3. Implement BotFather automation (create bot)
4. Implement group creation + admin setup
5. Implement sealed config output
6. Test end-to-end on SecretVM

### Week 5: Config Governance
1. Add `config_entries` and `config_history` tables to guardian schema
2. Add `config_update` and `api_key_rotation` proposal types
3. Add config API routes: `GET /api/config/current`, `POST /api/sentry/config/propose`
4. Add config execution on proposal pass
5. Write tests

### Week 6: Integration
1. Modify agent `index.ts` to use Solana registry for discovery
2. Modify agent to load sealed config for Telegram credentials
3. Add config sync cron job to agent
4. Modify guardian to use Solana registry for agent discovery
5. Remove `BOOTSTRAP_GUARDIANS`, make `FUND_MANAGER_ENDPOINT` optional
6. End-to-end test: boot agent → agent starts → guardian discovers → attestation → heartbeat → config sync

### Week 7: Testing + Hardening
1. Full integration tests
2. Security review: verify no credential leakage paths
3. Test guardian config governance flow end-to-end
4. Test boot agent on fresh SecretVM
5. Test agent restart with sealed config persistence

---

## Architecture Diagram

```
                        ┌──────────────────────────┐
                        │    Solana Blockchain       │
                        │                            │
                        │  Discovery Registry (PDA)  │
                        │  - Agent endpoint          │
                        │  - Guardian endpoints      │
                        │  - Attestation hashes      │
                        │  - Heartbeat timestamps    │
                        └─────┬──────────────┬──────┘
                         reads│              │writes
                              │              │
              ┌───────────────┘              └───────────────┐
              │                                              │
   ┌──────────▼──────────┐        HTTPS/signed          ┌───▼──────────────────┐
   │  Guardian (TEE)      │◄──────envelopes────────────►│  Fund Agent (TEE)     │
   │                      │                              │                       │
   │  EXISTING:           │  attestation, heartbeat,     │  EXISTING:            │
   │  - Sentry governance │  DB sync, config delivery    │  - Trading engine     │
   │  - Proposals/voting  │                              │  - NFT minting        │
   │  - DB backups        │                              │  - Marketplace        │
   │  - Health monitoring │                              │  - /status endpoint   │
   │  - Attestation       │                              │  - Fund accounting    │
   │                      │                              │                       │
   │  NEW:                │                              │  NEW:                 │
   │  - Config governance │                              │  - Solana registry    │
   │  - Config API        │                              │  - Config sync        │
   │                      │                              │  - Sealed config load │
   │  TG: /vote, /status  │                              │  TG: buyer DMs/sales  │
   │  (human operators)   │                              │  (token from boot     │
   └──────────────────────┘                              │   agent, in TEE only) │
                                                         └───────────────────────┘
                                                                    ▲
                                                                    │ created by
                                                         ┌──────────┴──────────┐
                                                         │  Boot Agent (TEE)    │
                                                         │  ONE-TIME ONLY       │
                                                         │                      │
                                                         │  GramJS + Twilio     │
                                                         │  → Create TG bot     │
                                                         │  → Create group      │
                                                         │  → Seal config       │
                                                         │  → Exit              │
                                                         └─────────────────────┘
```

---

## Success Criteria

- [ ] Agent discovers guardians via Solana registry (no hardcoded endpoints)
- [ ] Guardian discovers agent via Solana registry (no hardcoded endpoints)
- [ ] Bot token created inside TEE by boot agent (no human sees it)
- [ ] Config changes flow through guardian governance (no SSH to agent)
- [ ] All existing functionality preserved (251 tests still pass)
- [ ] Attestation, heartbeat, DB sync all work over HTTPS
- [ ] Single human input at launch: Twilio API key (for SMS verification)
- [ ] After launch: NO HUMAN CONTROL over agent operations

---

## Costs

```
New Infrastructure:
├── Solana program deployment: ~$2 (devnet free, mainnet ~$2)
├── Twilio phone number: ~$1/month + $0.0075/SMS
├── Boot agent VM: $0.50 (runs for 15 minutes then destroyed)
└── Total one-time: ~$5

Ongoing (unchanged):
├── Agent VM (SecretVM): ~$50/month
├── Guardian VM (SecretVM): ~$50/month
├── Helius RPC: $0 (free tier)
├── SecretAI: ~$25/month
└── Total monthly: ~$125/month
```
