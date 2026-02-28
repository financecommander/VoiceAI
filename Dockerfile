# ============================================================================
# Calculus Voice Agent — Production Dockerfile
# ============================================================================
# Multi-stage build: install deps → compile TypeScript → slim runtime image
# Final image: ~180MB (node:20-slim + compiled JS + native deps)
# ============================================================================

# Stage 1: Install dependencies
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 2: Build TypeScript
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src/ src/
COPY drizzle.config.ts ./
RUN npx tsc

# Stage 3: Production runtime
FROM node:20-slim AS runner
WORKDIR /app

# Security: run as non-root
RUN addgroup --system --gid 1001 calculus && \
    adduser --system --uid 1001 --ingroup calculus agent

# Copy compiled output + production deps
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY src/config/ dist/config/

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

USER agent
EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["node", "dist/gateway/server.js"]
