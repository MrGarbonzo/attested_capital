FROM node:22-alpine

# Install native build deps for better-sqlite3
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production=false

COPY tsconfig.json ./
COPY src/ ./src/
COPY deploy/IDENTITY.md ./deploy/IDENTITY.md

RUN npx tsc

# Copy schema.sql to compiled output (needed at runtime by DatabaseLedger)
RUN cp src/database/schema.sql dist/database/schema.sql

# Prune dev deps
RUN npm prune --production

# Remove src/ — only dist/ needed at runtime
RUN rm -rf src/ tsconfig.json

EXPOSE 8080
CMD ["node", "dist/agent/index.js"]
