FROM node:22-slim

WORKDIR /app

# Install curl (for agent to POST to bridges)
RUN apt-get update && apt-get install -y curl procps && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Frontend deps + build
COPY admin-ui/ admin-ui/
RUN cd admin-ui && pnpm install --frozen-lockfile && pnpm build

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN npx tsc

# Copy role templates (used at runtime for workspace init)
COPY roles/ roles/

EXPOSE 3001

# Root agent workspace (ephemeral); worker workspace at /workspace (volume-backed)
CMD ["node", "dist/index.js", "/workspace-root"]
