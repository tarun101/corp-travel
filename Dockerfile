# Playwright's browser binary must match the installed npm package version
# exactly, so we install Chromium at build time via `playwright install`
# rather than relying on a base image's bundled browser version.

FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/dist ./dist
# Baked-in defaults — override for a real deployment via the POLICY_JSON /
# PREFERENCES_JSON env vars (see README) rather than editing these.
COPY policy.example.json ./policy.json
COPY user_preferences.example.json ./user_preferences.json

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

# MCP_BEARER_TOKEN has no default on purpose — the server refuses to start
# without it. Pass it at `docker run` / platform env-var config time.
CMD ["node", "dist/remoteServer.js"]
