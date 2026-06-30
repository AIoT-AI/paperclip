# syntax=docker/dockerfile:1.20
# Ghim Node 24.15.0: bản 24.16.0+ dính regression yauzl làm treo khâu giải nén
# browser của Playwright 1.58.2 (chromium-headless-shell). Gỡ ghim này được sau
# khi project nâng Playwright >= 1.60. Xem playwright#34508, #40724.
FROM node:24.15.0-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

# ---------------------------------------------------------------------------
# Playwright browser binaries — own stage so the slow (~100MB+, yauzl-bound)
# Chromium download is keyed on the dependency graph (`deps`), NOT on app source.
# Previously this ran in the production stage AFTER `COPY --from=build /app /app`,
# so every server/ui code edit busted its cache and re-downloaded Chromium — the
# main reason ordinary builds were slow. Now a code-only change reuses this layer.
#
# Success = full Chromium (chrome-linux64), which always downloads cleanly. The
# headless-shell variant sometimes gets CDN-throttled; it's optional (full
# Chromium runs headless via --headless=new) so a missing shell never fails here.
# ---------------------------------------------------------------------------
FROM deps AS browsers
ARG PLAYWRIGHT_INSTALL_TIMEOUT=900
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd /app \
  && { for i in $(seq 1 3); do \
       timeout "$PLAYWRIGHT_INSTALL_TIMEOUT" ./node_modules/.bin/playwright install chromium && break; \
       ls -d /ms-playwright/chromium-*/chrome-linux64 >/dev/null 2>&1 && { echo "== da co Chromium day du -> dung som =="; break; }; \
       echo "== playwright retry $i (chua co Chromium day du, thu lai) =="; \
       sleep 3; \
     done; } \
  && if ls -d /ms-playwright/chromium-*/chrome-linux64 >/dev/null 2>&1; then \
       echo "OK: Chromium day du da co (headless-shell la tuy chon)."; \
       chmod -R a+rx /ms-playwright; \
     else \
       echo "LOI: thieu Chromium day du - build that bai."; exit 1; \
     fi

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
ARG DOCKER_GID=981
# Default TRUE: image này dùng cho QA agent (cần browser). Để true để dù build
# kiểu gì (compose / docker build tay / quên truyền arg) cũng luôn có Chromium.
# Đổi về false nếu cần build server-only nhẹ (không QA giao diện).
ARG INSTALL_PLAYWRIGHT=true
ARG PLAYWRIGHT_INSTALL_TIMEOUT=900
WORKDIR /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq docker-cli \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -g ${DOCKER_GID} --non-unique docker-host \
  && usermod -aG docker-host node \
  && mkdir -p /paperclip /opt/npm-cache \
  && chown node:node /paperclip /opt/npm-cache

# Docker Compose v2 plugin — QA e2e (vd DXS-77, DXS-88) cần `docker compose` để
# dựng stack app qua DooD. docker-cli ở trên KHÔNG kèm subcommand compose.
# Pin binary trực tiếp từ GitHub release: reproducible, KHÔNG phụ thuộc apt may rủi
# (đoạn apt best-effort cũ có thể âm thầm fail -> image thiếu compose mà build vẫn xanh).
# Bản hiện hành: v5.1.4 (2026-05-20). Bump version ở ARG khi cần nâng.
# Server x86_64 -> docker-compose-linux-x86_64; đổi -aarch64 nếu host là ARM.
ARG DOCKER_COMPOSE_VERSION=v5.1.4
RUN mkdir -p /usr/libexec/docker/cli-plugins \
  && curl -fSL "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-linux-x86_64" \
       -o /usr/libexec/docker/cli-plugins/docker-compose \
  && chmod +x /usr/libexec/docker/cli-plugins/docker-compose \
  && docker compose version

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --chown=node:node --from=build /app /app

# Chromium's RUNTIME system libraries (apt). The browser BINARIES themselves are
# copied (cached) from the `browsers` stage below — they are NOT re-downloaded per
# build. `install-deps` is apt-only here, so a code change costs an apt run, not a
# ~100MB Chromium download.
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      cd /app && ./node_modules/.bin/playwright install-deps chromium; \
    else \
      echo "Skipping Playwright system deps. Set --build-arg INSTALL_PLAYWRIGHT=true for browser QA."; \
    fi \
  && rm -rf /var/lib/apt/lists/*

# Cached browser binaries from the `browsers` stage (keyed on deps, not app code).
COPY --chown=node:node --from=browsers /ms-playwright /ms-playwright

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  NPM_CONFIG_CACHE=/opt/npm-cache

VOLUME ["/paperclip"]
EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
