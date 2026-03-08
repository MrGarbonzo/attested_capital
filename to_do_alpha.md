# Alpha TODO — Boot to Testing

## Status Summary

| Repo | TS Compiles | Docker Image | Tests |
|------|------------|--------------|-------|
| boot-agent | YES | Ready to build (simplified, no .so/keypair) | N/A (no tests) |
| solana-registry | SDK: YES | N/A (Anchor program) | NOT RUN (no Anchor CLI) |
| guardian-network | YES | Ready to build | 118 pass / 0 fail (shared) + 65 sqlite (Windows-only) |
| panthers-fund | YES | Ready to build | 251 pass / 0 fail |

---

## BLOCKING — Must do before first boot

### 1. Deploy registry to devnet (ONE-TIME, developer action)
- **What:** The registry is a Solana program deployed once. Agents/guardians use it via `REGISTRY_PROGRAM_ID`.
- **Options:**
  - **A) Build + deploy from this machine** — requires Rust, Solana CLI, Anchor CLI
  - **B) Build + deploy from a Linux machine/VM** — easier native compilation
  - **C) Skip for now** — use a mock/stub registry, or test boot-agent without on-chain verify
- **Steps (if building):**
  ```bash
  # Install toolchain (Linux/WSL)
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"
  cargo install --git https://github.com/coral-xyz/anchor avm && avm install 0.30.1 && avm use 0.30.1

  # Build + test
  cd solana-registry
  anchor build
  anchor test   # starts local validator

  # Deploy to devnet
  solana config set --url devnet
  solana airdrop 5
  anchor deploy --provider.cluster devnet
  # Verify: solana program show REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa --url devnet
  ```
- **Program ID:** `REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa`
- See `solana-registry/DEPLOY.md` for full guide

### 2. Start Docker Desktop
- Docker is installed (v29.1.3) but daemon is **not running**
- Start Docker Desktop → wait for daemon

### 3. Build Docker images
```bash
cd boot-agent      && docker build -t panthers-boot-agent .
cd guardian-network && docker build -t panthers-guardian .
cd panthers-fund   && docker build -t panthers-agent .
```
- boot-agent: `node:22-alpine` — lightweight, no Solana CLI needed
- guardian: `node:22-alpine` — `better-sqlite3` compiles in alpine
- agent: `node:22-alpine` with `python3 make g++` for native deps

### 4. Create .env files with real credentials
- Copy `.env.example` → `.env` in boot-agent
- Fill in:
  - `TELEGRAM_BOT_TOKEN` — from @BotFather (agent bot)
  - `GUARDIAN_TELEGRAM_BOT_TOKEN` — from @BotFather (guardian bot)
  - `TELEGRAM_GROUP_CHAT_ID` — shared group for protocol messages
  - `SECRET_AI_API_KEY` — Secret Network AI API key
  - `REGISTRY_PROGRAM_ID` — from step 1 (already defaulted in .env.example)
  - `SOLANA_RPC_URL` — devnet RPC (default: https://api.devnet.solana.com)

---

## DONE

- [x] All 4 repos compile clean (TypeScript `--noEmit` passes)
- [x] Seal utilities extracted to guardian + agent
- [x] Unseal entrypoint added to guardian + agent
- [x] Fixed `updateEndpoint` TS error in agent's `SolanaRegistryClient`
- [x] Boot-agent Dockerfile created
- [x] Per-VM docker-compose.yml for boot-agent, guardian, agent
- [x] `.env.example` for all 3 repos
- [x] Guardian docker-compose updated with sealed-config mount
- [x] Agent docker-compose rewritten for production
- [x] Fixed solana-registry SDK missing `@types/node` dev dependency
- [x] **Simplified boot-agent: removed registry deployment** (reads `REGISTRY_PROGRAM_ID` from env)
- [x] **Removed FUNDING_KEYPAIR / drainFundingKeypair** (no deployer keypair concept)
- [x] **Dockerfile simplified to node:22-alpine** (no Solana CLI, no .so, no keypair)
- [x] **Switched attestation from MRTD to RTMR3** (container image measurement = GHCR identity)
- [x] **Fixed expiry check bug** (`maxAgeSeconds: 0` was falsy, skipped check; also `>` → `>=`)
- [x] **Fixed X25519 signature bug** (dev signer signed raw bytes but verifier checked base64 string)
- [x] **All attestation tests pass** (118/118 guardian shared, 251/251 panthers-fund)
- [x] **Created registry deployment guide** (`solana-registry/DEPLOY.md`)

---

## TEST STATUS

### Guardian-network shared tests: 118 pass / 0 fail
- attestation.test.ts (9)
- attestation-verifier.test.ts (8)
- tee-signer.test.ts (10)
- trust-store.test.ts (14)
- signed-envelope.test.ts (19)
- vault.test.ts (15)
- telegram-protocol.test.ts (31)
- registry-client.test.ts (12)

### Guardian-network DB-dependent tests: 65 fail (Windows-only)
- `better-sqlite3` native module — not a code bug
- Will pass in Docker (Linux + alpine build tools)

### Guardian-network sentry tests: pass (non-DB ones)
- agent-verification.test.ts (13)
- code-reviewer.test.ts (12)

### Panthers-fund: 251 pass / 0 fail

---

## LOW PRIORITY — Not blocking alpha

### Missing .dockerignore files
- `boot-agent/` and `panthers-fund/` — no .dockerignore
- Add to avoid slow Docker builds (copying node_modules into context)

### NFT metadata URI stub
- `panthers-fund/src/nft/minter.ts:106` — `uri: ''` placeholder
- NFTs mint with empty URI — no image/name on explorers

### NFT burn not fully implemented
- `panthers-fund/src/nft/minter.ts:174` — simplified burn

---

## DEPLOYMENT FLOW (local dev — single machine)

```
1. BOOT:
   cd boot-agent
   cp .env.example .env   # fill in tokens + keys + REGISTRY_PROGRAM_ID
   docker compose up      # reads env → vault key → sealed configs → verify registry → exits

   # Sealed configs written to ./sealed-output/
   # agent.sealed.json + guardian.sealed.json

2. GUARDIAN:
   cd guardian-network
   cp .env.example .env   # fill in GUARDIAN_EXTERNAL_ENDPOINT
   # Copy sealed config: cp ../boot-agent/sealed-output/guardian.sealed.json ./sealed-config/
   docker compose up -d   # unseals config → API on :3100

3. AGENT:
   cd panthers-fund
   cp .env.example .env   # fill in BOOTSTRAP_GUARDIANS=http://localhost:3100
   # Copy sealed config: cp ../boot-agent/sealed-output/agent.sealed.json ./sealed-config/
   docker compose up -d   # unseals config → registers → discovers guardian → heartbeat
```

## VERIFICATION CHECKLIST

- [ ] Boot-agent exits cleanly (`docker logs panthers-boot-agent`)
- [ ] Registry exists on devnet (`solana program show REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa --url devnet`)
- [ ] Guardian API responds (`curl http://localhost:3100/ping`)
- [ ] Agent status responds (`curl http://localhost:8080/status`)
- [ ] Agent registered on-chain (check Solana explorer for registry PDA)
- [ ] Guardian discovered agent from registry (check guardian logs)
- [ ] Agent heartbeat running (check agent logs for "heartbeat" every 30s)
- [ ] Send Telegram message → LLM routes to tool → response
