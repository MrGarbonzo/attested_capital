FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
COPY database/ ./database/

RUN npm run build

# ── Production ────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist/ ./dist/
COPY database/ ./database/

# Data volume for SQLite
RUN mkdir -p /data
VOLUME /data

ENV DB_PATH=/data/guardian.db
ENV PORT=3100
ENV SOLANA_RPC_URL=https://api.devnet.solana.com

EXPOSE 3100

CMD ["node", "dist/guardian/main.js"]
