FROM node:24-bookworm-slim AS builder
ARG UPSTREAM_REF=d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e
WORKDIR /opt/rewards
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --retry 3 "https://codeload.github.com/TheNetsky/Microsoft-Rewards-Script/tar.gz/${UPSTREAM_REF}" -o /tmp/upstream.tar.gz \
    && tar -xzf /tmp/upstream.tar.gz --strip-components=1 -C /opt/rewards
RUN npm ci --ignore-scripts && npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers FORCE_HEADLESS=1 \
    PANEL_HOST=0.0.0.0 PANEL_PORT=4173 PANEL_REMOTE_DESKTOP=1 \
    BOT_DIR=/opt/rewards PANEL_CONFIG=/data/panel.json
WORKDIR /opt/rewards
COPY --from=builder /opt/rewards/package*.json ./
COPY --from=builder /opt/rewards/LICENSE ./LICENSE
COPY --from=builder /opt/rewards/node_modules ./node_modules
COPY --from=builder /opt/rewards/dist ./dist
# The official headless image omits these manual-login dependencies.
COPY --from=builder /opt/rewards/scripts ./scripts
COPY --from=builder /opt/rewards/config.example.json ./config.example.json
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 xvfb x11vnc novnc websockify util-linux ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && npx --no-install patchright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm
WORKDIR /opt/panel
COPY package.json server.js ./
COPY public ./public
COPY lib ./lib
COPY docker ./docker
# Pinned upstream compatibility change: reload edited account fields for API requests.
RUN node docker/prepare-upstream.mjs /opt/rewards
# Fail the build if the viewer's interpreter or either browser mode is broken.
RUN python3 -c "import websockify" && node docker/smoke.mjs && node docker/activity-smoke.mjs
EXPOSE 4173
ENTRYPOINT ["node", "docker/entrypoint.mjs"]
