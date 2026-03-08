# Attested Capital: Panthers — Status Update (March 2, 2026)

## What's Done

### Phase 1 Critical Fixes (all 6 deployed March 1-2)
- [x] **P&L double-distribution** — fixed proportional allocation bug
- [x] **DB sync trust store** — fixed sender lookup in snapshot receiver
- [x] **Health check spam** — reduced log noise from guardian health monitoring
- [x] **LLM resilience** — SecretAI-only; bot no longer dies when LLM hangs
- [x] **Vault key persistence** — VaultKeyManager seals key to TEE storage, survives restarts
- [x] **APPROVED_MEASUREMENTS** — guardian locked to specific MRTD hashes

### Per-Interaction Attestation (deployed March 2)
- [x] **PCCS nesting bug** — `report.quote.mr_td` unwrapping fixed in `attestation-verifier.ts`
- [x] **`verifyInlineAttestation()`** — new function verifies fresh TEE quote without modifying trust store
- [x] **Agent sends attestation quote** — `cron.ts` loads fresh quote before every DB sync
- [x] **Guardian verifies on receive** — `db-sync.ts` and `recovery.ts` check inline attestation
- [x] **`REQUIRE_INLINE_ATTESTATION=true`** — set on guardian, enforcing per-interaction proof
- [x] **Both images deployed** — guardian (67.43.239.6) and agent (67.215.13.107) both healthy

### Infrastructure
- [x] Guardian VM: 67.43.239.6 (SecretVM, TDX, sentry mode)
- [x] Agent VM: 67.215.13.107 (SecretVM, TDX, 45 tools)
- [x] Telegram coordination working (bootstrap discovery + group)
- [x] Heartbeat system (60s interval, auto-deactivation)
- [x] Agent registration + attestation verified
- [x] DB sync scheduled hourly with fresh TEE attestation

---

## What's Left

### Priority 2 — Production Readiness (next 2 weeks)
- [ ] **Real trading setup** — Jupiter API key, mainnet Solana RPC, fund wallet with SOL + USDC
- [ ] **Multi-guardian deployment** — deploy 2-3 more guardians for resilience (currently only 1)
- [ ] **DB sync recovery e2e test** — destroy agent, redeploy, verify DB restored from guardian
- [ ] **Duplicate agent prevention test** — verify second agent is rejected while first is healthy

### Priority 3 — Core Features (month 1)
- [ ] **Dynamic NFT sales** — flash auctions, negotiations, gumball pricing (designed, not tested)
- [ ] **P2P NFT escrow** — list/buy/cancel marketplace (designed, not tested)
- [ ] **Portfolio allocation guidelines** — max 80% trading, 20% cash reserve, per-asset limits
- [ ] **Monitoring dashboard** — /metrics endpoint with pool balance, P&L, guardian health
- [ ] **Withdrawal flow** — 2% exit fee, proportional distribution to remaining holders

### Priority 4 — Advanced (month 2+)
- [ ] **Arbitrum chain + bridging** — Circle CCTP / Wormhole for cross-chain USDC
- [ ] **Agent-owned Twitter/X** — daily stats, trade announcements, mention replies
- [ ] **NFT viewing system** — Telegram mini app or generated image cards
- [ ] **API change monitoring** — guardian detects Jupiter API changes, alerts agent
- [ ] **Telegram auto-setup** — agent programmatically creates bot + group via BotFather
- [ ] **On-chain NFT minting** — Metaplex Bubblegum on Solana
- [ ] **Governance voting** — 20% threshold for strategy changes, weighted by NFT value

---

## Deployment Reference

| VM | IP | SSH Key | Container | Image |
|----|-----|---------|-----------|-------|
| Guardian | 67.43.239.6 | `~/.ssh/guardian_vm_key` | `panthers-guardian` | `panthers-guardian:latest` |
| Agent | 67.215.13.107 | `~/.ssh/secretvm_key` | `docker_wd-panthers-agent-1` | `panthers-fund:latest` |

**Deploy flow:** tar source → scp to VM → docker build → docker compose down/up
