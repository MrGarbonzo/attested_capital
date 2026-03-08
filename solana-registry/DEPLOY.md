# Solana Registry — Deployment Guide

The registry program is deployed **once** by a developer. Agents and guardians
interact with it via transactions using the `REGISTRY_PROGRAM_ID`.

## Prerequisites

- Solana CLI installed (`solana --version`)
- Anchor CLI installed (`anchor --version`)
- A funded Solana keypair (`solana balance`)

## 1. Build the program

```bash
anchor build
```

This produces `target/deploy/solana_registry.so` and
`target/deploy/solana_registry-keypair.json`.

## 2. Deploy to devnet

```bash
anchor deploy --provider.cluster devnet
```

The program ID is determined by the keypair in `target/deploy/` and is
configured in `Anchor.toml`:

```
REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa
```

## 3. Configure downstream services

Set `REGISTRY_PROGRAM_ID` in the boot-agent `.env`:

```env
REGISTRY_PROGRAM_ID=REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa
```

The boot-agent reads this at startup and writes it into sealed configs for
both the agent and guardian containers.

## 4. Upgrading the program

```bash
anchor build
anchor upgrade target/deploy/solana_registry.so \
  --program-id REGSxrTBkiYMJoftPAxPXb4LPwuuJRP7oNkNbmWPVVa \
  --provider.cluster devnet
```

The program ID stays the same after upgrades. No changes needed in
downstream `.env` files.

## Architecture

```
Developer (one-time)          Boot Agent (every boot)
─────────────────────         ────────────────────────
anchor build                  reads REGISTRY_PROGRAM_ID
anchor deploy                 generates vault key
  ↓                           writes sealed configs
Program on-chain              verifies registry on-chain
  ↓                           exits
REGISTRY_PROGRAM_ID
  ↓
.env for boot-agent
```
