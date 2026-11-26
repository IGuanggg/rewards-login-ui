# Docker 部署

本镜像打包了面板与上游 `Microsoft-Rewards-Script v5.0.0`（含完整 Chromium、Xvfb、x11vnc、websockify），无桌面 Linux 服务器可直接在网页里完成微软登录和日常签到。

## 启动

```bash
docker compose up -d --build
docker compose logs --tail=60 rewards
```

国内服务器构建时如需走局域网代理（如 mihomo，加快拉取 GitHub 源码与 Chrome 156）：

```bash
HTTP_PROXY=http://宿主机局域网IP:代理端口 HTTPS_PROXY=http://宿主机局域网IP:代理端口 docker compose up -d --build
```

首次启动日志会打印访问密码，也可在环境变量中通过 `PANEL_TOKEN` 指定。

默认仅映射 `127.0.0.1:4173`，通过 SSH 隧道在本地访问：

```bash
ssh -N -L 4173:127.0.0.1:4173 用户名@服务器IP
```

打开 `http://127.0.0.1:4173` 即可。使用 Nginx / Caddy 反向代理时，转发至 `127.0.0.1:4173` 并开启 WebSocket 支持，无需暴露 5900 / 6080 / 3010 端口。

## 远程浏览器登录

1. 登录后在「账号」页添加微软邮箱并保存。
2. 点击「登录账号」，选择移动端、桌面端或两端，点击「启动浏览器授权」。
3. 点击出现的「打开远程浏览器」，在新标签页完成登录验证。
4. 完成后回到面板确认对应平台已显示 Cookie 数量与更新时间，之后签到直接复用会话。

授权结束后会自动回收 Xvfb / VNC / 浏览器进程；超过 15 分钟（可用 `LOGIN_TIMEOUT_MINUTES` 调整）也会自动清理。

## 资源与内存模式

`compose.yaml` 默认限制：内存上限 `1536 MiB`、CPU `1.5 核`、`/dev/shm` `256 MiB`，账号与搜索默认串行运行。

上游 v5.0.0 默认开启 **纯接口模式**（`rewardsMode: api`）：登录后自动关闭浏览器，搜索与日常活动直接走 HTTP，显著降低运行期内存占用。如需切换完整浏览器渲染，可在「设置 → 签到策略」调整。

## 数据目录与升级迁移

所有持久化数据存放在宿主机 `./data/`，重建或升级镜像不会丢失：

| 路径 | 说明 |
| --- | --- |
| `data/panel.json` | 面板密码与内部接口配置 |
| `data/accounts.env` | 微软账号配置 |
| `data/bot-config.json` | 上游签到配置 |
| `data/sessions/` | `sessions.db` 登录会话库 |
| `data/activity.db` | 最近 30 天签到记录与日志 |
| `data/schedule.json` | 每日定时配置 |
| `data/notifications.json` | 推送渠道配置 |
| `data/query-mode.json` | 国区搜索词源模式 |

从旧版本升级直接执行 `docker compose up -d --build` 即可，已有账号与 `sessions.db` 会自动保留，旧版配置字段会在启动时自动兼容迁移。

## 每日定时

在「设置 → 签到策略 → 每日定时」开启并保存即可即时生效。也可在同目录 `.env` 中设置初始值：

```dotenv
TZ=Asia/Shanghai
RUN_AT=08:30
```

## 烟雾检查

构建完成后可在不配置账号的情况下检查浏览器与远程桌面组件是否正常：

```bash
docker compose run --rm --no-deps --entrypoint node rewards docker/smoke.mjs
```
