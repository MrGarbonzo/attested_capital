# ── Stage 1: Build the Solana registry .so ─────────────────────
FROM backpackapp/build:v0.30.1 AS anchor-builder

WORKDIR /build
COPY solana-registry/Cargo.toml solana-registry/Anchor.toml ./
COPY solana-registry/programs/ programs/
RUN solana-keygen new --no-bip39-passphrase -o /root/.config/solana/id.json && anchor build

# ── Stage 2: Build boot-agent TypeScript ───────────────────────
FROM node:22-alpine AS builder

WORKDIR /build
COPY boot-agent/package.json boot-agent/package-lock.json* ./
RUN npm install
COPY boot-agent/tsconfig.json ./
COPY boot-agent/src/ src/
RUN npm run build

# ── Stage 3: Production ───────────────────────────────────────
FROM node:22-slim

# Install Solana CLI (needs glibc — Alpine won't work)
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates && \
    sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    ln -s /root/.local/share/solana/install/active_release/bin/solana /usr/local/bin/solana && \
    apt-get purge -y curl bzip2 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built JS
COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/node_modules/ node_modules/
COPY boot-agent/package.json ./

# Copy pre-built registry .so
COPY --from=anchor-builder /build/target/deploy/solana_registry.so /opt/solana-registry/solana_registry.so

# Sealed config output directory (mounted as shared volume)
VOLUME /mnt/secure/boot-config

ENTRYPOINT ["node", "dist/index.js"]
