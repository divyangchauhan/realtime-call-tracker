# ─────────────────────────────────────────────────────────────────────────────
# Stage 1: builder
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Enable corepack so pnpm is available at the pinned version
RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Copy manifests first for better layer caching
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2: runner
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@10.20.0 --activate

# Copy manifests and install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/dist ./dist

# Default command starts the API server.
# The worker service in docker-compose.yml overrides this with: node dist/worker
CMD ["node", "dist/main"]
