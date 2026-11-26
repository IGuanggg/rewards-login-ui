# Rewards 控制台

[TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 的 Web 控制面板。基于 Node.js 内置模块实现，零依赖、零构建，适配上游 **v5.0.0** 内核。

## 功能

- **账号与双端授权**：网页管理 `.env` 账号配置，支持手机端 / 电脑端独立或连续登录，自动校验 `sessions.db` 会话写入状态；Docker 模式下内置 noVNC 远程浏览器。
- **上游 v5.0.0 适配**：支持纯接口执行模式（`rewardsMode: api`，低内存占用）、连续签到防断签（`ensureStreakProtection`）及活动间隔配置，兼容旧版配置与会话平滑升级。
- **签到工作台与趋势**：一键启动 / 停止全部或单个账号签到，查看 14 天积分走势、单账号余额与最近 30 天任务明细日志。
- **国区词源与定时**：内置国内热词与中文离线词库兜底，支持每日定时自动运行。
- **多渠道推送**：支持 PushPlus（HTML 卡片）、Server酱 Turbo（Markdown 报表）、Bark（分级通知），设置页可直接预览样式并发送测试推送。
- **双外观界面**：Apple 风格浅色 / 深色外观一键切换，桌面侧边栏与移动端底部导航自适应。

## 快速开始

### Docker 部署（推荐，适合 Linux 服务器）

```bash
docker compose up -d --build
docker compose logs --tail=60 rewards
```

默认监听宿主机 `127.0.0.1:4173`，通过 SSH 端口转发或 HTTPS 反向代理访问，首次启动日志会打印随机访问密码。完整说明见 [docs/Docker部署.md](docs/Docker部署.md)。

### 本机运行

将本目录放在 `Microsoft-Rewards-Script` 仓库内（或任意目录），启动服务：

```bash
node server.js
```

打开终端输出的地址（默认 `http://127.0.0.1:4173`），输入打印的访问密码即可。首次进入时若未自动探测到仓库，填写脚本根目录完成检查即可连接。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `4173` | 监听端口 |
| `PANEL_HOST` | `127.0.0.1` | 监听地址 |
| `PANEL_TOKEN` | 随机生成 | 访问密码（优先于 `config.json`） |
| `PANEL_NO_AUTH` | 关闭 | 设为 `1` 关闭密码登录 |
| `PANEL_CONFIG` | `./config.json` | 面板配置文件路径 |
| `BOT_DIR` | 自动探测 | 上游脚本仓库根目录 |

## Control API 接入（本机模式）

Docker 模式已自动接通内部接口。本机模式如需在面板内直接启动签到，在上游 `.env` 中配置并启动 API：

```dotenv
API_TOKEN=你的随机令牌
API_HOST=127.0.0.1
API_PORT=3010
```

```bash
npm run api
```

随后在面板「设置 → 系统与环境 → Control API」填入地址与令牌并测试连通即可。

## 测试

```bash
node tools/acceptance.mjs
npm run test:activity
npm run test:run
npm run test:china
npm run test:docker
```

## 目录结构

```text
rewards-login-ui/
├── server.js          # HTTP 服务、鉴权、配置读写、子进程与 SSE
├── lib/               # 活动记录、国区词源、消息推送、签到配置、远程桌面代理
├── docker/            # Docker 入口、上游 v5 补丁与任务调度
├── public/            # 前端页面、样式与 ES 模块脚本
├── tools/             # 自动化测试与隔离预览脚本
├── Dockerfile
├── compose.yaml
└── docs/Docker部署.md
```
