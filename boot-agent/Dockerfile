# ── Stage 1: Build the Solana registry .so ─────────────────────
FROM backpackapp/build:v0.31.0 AS anchor-builder

WORKDIR /build

# Upgrade platform-tools so cargo-build-sbf has Cargo >= 1.85 (edition2024 support)
# v1.52 is the latest version that still includes the sbf-solana-solana target
# required by cargo-build-sbf v2.1.0 (v1.53+ renamed it to sbpf-solana-solana)
# Preserve version.md so cargo-build-sbf doesn't try to reinstall v1.43
RUN PT_CACHE="/root/.cache/solana/v1.43/platform-tools" && \
    cp "$PT_CACHE/version.md" /tmp/pt-version.md && \
    rm -rf "$PT_CACHE" && mkdir -p "$PT_CACHE" && \
    curl -fsSL "https://github.com/anza-xyz/platform-tools/releases/download/v1.52/platform-tools-linux-x86_64.tar.bz2" \
      | tar -xj -C "$PT_CACHE" && \
    cp /tmp/pt-version.md "$PT_CACHE/version.md"

COPY solana-registry/Cargo.toml solana-registry/Anchor.toml ./
COPY solana-registry/programs/ programs/
# Place the fixed program keypair where Anchor expects it so declare_id! matches
COPY solana-registry/program-keypair.json target/deploy/solana_registry-keypair.json
RUN solana-keygen new --no-bip39-passphrase -o /root/.config/solana/id.json && anchor build --no-idl

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

# Install Solana CLI + secretvm-cli (needs glibc — Alpine won't work)
RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 ca-certificates && \
    sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)" && \
    for bin in /root/.local/share/solana/install/active_release/bin/*; do ln -sf "$bin" /usr/local/bin/; done && \
    npm install -g secretvm-cli && \
    apt-get purge -y curl bzip2 && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built JS
COPY --from=builder /build/dist/ dist/
COPY --from=builder /build/node_modules/ node_modules/
COPY boot-agent/package.json ./

# Copy pre-built registry .so and fixed program keypair
COPY --from=anchor-builder /build/target/deploy/solana_registry.so /opt/solana-registry/solana_registry.so
COPY solana-registry/program-keypair.json /opt/solana-registry/program-keypair.json

ENTRYPOINT ["node", "dist/index.js"]
