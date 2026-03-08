FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

# Copy non-TS assets needed at runtime
COPY deploy/IDENTITY.md ./deploy/IDENTITY.md

RUN npx tsc

# Copy schema.sql to compiled output (needed at runtime by DatabaseLedger)
RUN cp src/database/schema.sql dist/database/schema.sql

# --- Production stage ---
FROM node:22-alpine

RUN apk add --no-cache python3 make g++ wget

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/deploy/ ./deploy/

RUN mkdir -p /data

CMD ["node", "dist/agent/index.js"]
