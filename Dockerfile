FROM node:22-slim

WORKDIR /app

# Install curl (for agent to POST to bridges)
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Enable corepack for pnpm
RUN corepack enable

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY tsconfig.json ./
COPY src/ src/
RUN pnpm build

EXPOSE 3000 3001

# workspace is created at /workspace inside container
CMD ["node", "dist/index.js", "/workspace"]
