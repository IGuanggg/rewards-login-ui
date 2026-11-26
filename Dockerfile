FROM node:24-bookworm-slim AS builder
ARG UPSTREAM_REF=b78f6165f1d167d2906f662e1885c0cca528b255
ARG UPSTREAM_TARBALL_URL=https://codeload.github.com/TheNetsky/Microsoft-Rewards-Script/tar.gz/${UPSTREAM_REF}
ARG NPM_REGISTRY=
WORKDIR /opt/rewards
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --retry 3 "${UPSTREAM_TARBALL_URL}" -o /tmp/upstream.tar.gz \
    && tar -xzf /tmp/upstream.tar.gz --strip-components=1 -C /opt/rewards \
    && rm -f /tmp/upstream.tar.gz
RUN if [ -n "${NPM_REGISTRY}" ]; then npm config set registry "${NPM_REGISTRY}"; fi \
    && npm ci --include=dev --ignore-scripts && npm run build \
    && rm -rf node_modules && npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-bookworm-slim
ENV NODE_ENV=production TZ=Asia/Shanghai \
    PLAYWRIGHT_BROWSERS_PATH=/opt/browsers FORCE_HEADLESS=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning \
    PANEL_HOST=0.0.0.0 PANEL_PORT=4173 PANEL_REMOTE_DESKTOP=1 \
    BOT_DIR=/opt/rewards PANEL_CONFIG=/data/panel.json
WORKDIR /opt/rewards
COPY --from=builder /opt/rewards/package*.json ./
COPY --from=builder /opt/rewards/LICENSE ./LICENSE
COPY --from=builder /opt/rewards/node_modules ./node_modules
COPY --from=builder /opt/rewards/dist ./dist
COPY --from=builder /opt/rewards/scripts ./scripts
COPY --from=builder /opt/rewards/config.example.json ./config.example.json
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 xvfb x11vnc novnc websockify util-linux procps tzdata ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && ./node_modules/.bin/patchright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /root/.npm
WORKDIR /opt/panel
COPY package.json server.js ./
COPY public ./public
COPY lib ./lib
COPY docker ./docker
# 注入国区词源、真实等待进度以及账号热刷新适配（支持上游 v5.0.0）
RUN node docker/prepare-upstream.mjs /opt/rewards
# 构建阶段校验远程浏览环境与日志记录链路
RUN python3 -c "import websockify" && node docker/smoke.mjs && node docker/activity-smoke.mjs
EXPOSE 4173
ENTRYPOINT ["node", "docker/entrypoint.mjs"]
