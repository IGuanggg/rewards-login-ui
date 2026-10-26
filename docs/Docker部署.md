# 无桌面服务器的 Docker 部署

本目录提供一个同时包含面板和上游脚本的自建镜像。服务器不需要安装桌面。不要继续使用只安装了 headless shell 的上游原镜像启动手动登录。

## 为什么之前弹不出登录窗口

上游 `manualLogin.js` 强制使用可见 Chromium；上游官方 Dockerfile 仅安装 headless shell，而且没有复制手动登录脚本。本镜像补全完整 Chromium 和脚本，授权时临时启动 Xvfb、x11vnc、websockify，再通过面板的访问密码保护 noVNC 页面与 WebSocket。

授权成功、失败、点击终止或超过 15 分钟，都会触发浏览器与显示服务清理。没有授权任务时，这些显示服务不启动；面板和 Control API 常驻。签到使用无头模式，账号与搜索按串行配置运行，授权与签到共用进程锁。

实现依据：[Playwright 的 Xvfb 说明](https://playwright.dev/docs/ci)、[noVNC 部署说明](https://novnc.com/noVNC/docs/EMBEDDING.html)、[Docker Compose 资源限制](https://docs.docker.com/reference/compose-file/services/#mem_limit)。镜像固定上游版本 `d0f07d74a0ed4dda127855d6e3dde98bf4c89d6e`；更新此版本前需要重测兼容补丁。

## 启动

把整个 `rewards-login-ui` 文件夹传到 Linux 服务器，在该目录执行：

```bash
docker compose up -d --build
docker compose logs --tail=60 rewards
```

首次构建会下载 Node 依赖、Chromium 与系统组件，需要网络；镜像大小主要占磁盘，不代表常驻内存。日志会打印面板访问密码，也可以在部署平台给容器设置 `PANEL_TOKEN`。

默认只把服务器的 `127.0.0.1:4173` 映射出来。在自己的电脑建立 SSH 隧道：

```bash
ssh -N -L 4173:127.0.0.1:4173 用户名@服务器IP
```

然后打开电脑上的 `http://127.0.0.1:4173`。如果本机 4173 已被占用，将命令第一个端口改为 4174，再访问 `http://127.0.0.1:4174`。

已有 HTTPS 反向代理时，把代理指向服务器 `127.0.0.1:4173`，保留原 Host 并支持 WebSocket Upgrade。代理自身在另一个容器中时，可以让它加入同一 Docker 网络后访问 `rewards:4173`。无需发布 5900、6080 或 3010 端口。

## 完成授权

1. 输入面板访问密码。镜像内的实例目录与 Control API 已预配置，无须填写 Windows 路径。
2. 保存微软账号，选择移动端、桌面端或两端授权，点击「启动浏览器授权」。
3. 等待「打开远程浏览器」出现，点击后在新标签页完成微软验证。网页显示的是服务器容器内的浏览器。
4. 回到面板，确认对应平台显示会话实际写入。授权结束时远程页断开是正常现象。
5. 从面板启动签到。会话有效时继续复用；微软要求重新验证时再授权。

关闭远程标签页本身不会立即取消授权。可点面板「终止」，或者等待 15 分钟超时回收。取消或超时不会把未完成的平台标为成功。

## 4 GB 以上服务器的资源配置

`compose.yaml` 的起始配置为：

| 配置 | 值 |
| --- | --- |
| 容器内存硬上限 | 1536 MiB |
| 内存加 swap 总上限 | 1536 MiB，不给容器额外使用 swap |
| CPU 上限 | 1.5 核 |
| `/dev/shm` 容量上限 | 256 MiB，按使用量计入容器内存 |
| 账号并发 | 1 |
| 并行搜索、集群搜索 | 关闭 |
| 手动授权最长时间 | 15 分钟，可用 `LOGIN_TIMEOUT_MINUTES` 调为 1–60 |

**这些是限制值，不是实测占用或最低内存保证。** 到达内存上限可能被 OOM 终止，不能靠限制值保证任务完成。浏览器才是主要开销，具体取决于页面、验证流程及账号设置。镜像不安装完整桌面，也不让远程显示服务全天运行。

部署后分别观察空闲、授权、签到三个阶段：

```bash
docker stats
docker compose top rewards
```

授权结束后，进程列表中不应持续出现该授权任务的 Xvfb、x11vnc、websockify 和 Chromium。需要排查 OOM 时：

```bash
docker inspect --format '{{.State.OOMKilled}}' "$(docker compose ps -q rewards)"
docker compose logs --tail=100 rewards
```

`OOMKilled=false` 只能说明容器主进程没有因此退出，不能排除某个浏览器子进程被杀。若授权期间接近上限、发生崩溃，先把 `mem_limit` 和 `memswap_limit` 同时调至 `2g`，再测试；不建议强压到 256/512 MiB。

## 数据与迁移

所有运行数据保存在宿主机 `./data/`，重建镜像后保留：

| 文件 | 内容 |
| --- | --- |
| `data/panel.json` | 面板密码与内部 Control API 连接信息 |
| `data/accounts.env` | 面板保存的微软账号配置 |
| `data/bot-config.json` | 签到配置；启动时应用无头及串行设置 |
| `data/sessions/` | `sessions.db` 及 SQLite 辅助文件 |
| `data/activity.db` | 最近 30 天的签到轮次、任务明细和原始日志，附带 SQLite WAL/SHM 文件 |

迁移已有账号时，先停止旧签到进程，再把原上游 `.env` 复制为 `data/accounts.env`。需要迁移签到设置时，把原上游 `config.json` 复制为 `data/bot-config.json`；启动后会把 `sessionPath` 统一为 `/data/sessions`。不要把面板自身的 `config.json` 当成上游签到配置。

迁移会话时，停止旧进程后复制整个会话目录，或使用 SQLite 的备份功能。不要在写库期间只复制 `sessions.db` 而遗漏 WAL。登录所在地/IP 变化仍可能让微软要求重新验证，迁移 Cookie 不能保证免验证。

`data/` 已加入 Git 与 Docker 构建忽略。备份时停止容器再复制整个目录；该目录包含登录凭据与会话。

## 可选：每天定时签到

优先在“环境与设置 → 签到设置 → 每日定时”选择时间并保存，无需重启。页面显示是否开启和实例时区。任务开关、搜索间隔和搜索词来源也可以在此保存。

尚未通过面板保存定时配置时，也可在 Compose 使用的 `.env` 中填写：

```dotenv
TZ=Asia/Shanghai
RUN_AT=07:00
```

再执行 `docker compose up -d`。通过面板保存后，`data/schedule.json` 优先于 `RUN_AT`，包括关闭定时。没有配置时默认仅手动运行。每个自然日定时触发一次；到点正在授权或签到则当天跳过，不补跑。服务器错过该分钟也不补跑。日期标记持久保存以避免重启后同日重复触发。原上游的复杂 cron 配置不由这个轻量启动器读取。

## 容器内自检

构建后可以运行无需微软账号的烟雾检查，验证真实浏览器、虚拟显示和 noVNC 静态文件：

```bash
docker compose run --rm --no-deps --entrypoint node rewards docker/smoke.mjs
```

预期有 `PASS Chromium headed`、`PASS Chromium headless` 和 `PASS Xvfb + x11vnc + noVNC`。这不代替真实账号的授权验收。微软密码和二次验证由你在远程浏览器输入。

## 本次验证范围

本地通过：27 项面板回归、Docker 专项的配置/账号刷新/兼容补丁/HTTP 与 WebSocket 代理检查、JavaScript 语法检查、Compose 配置解析。

2026-10-23 本地 Docker 引擎未运行，当时没有完成镜像构建或 Linux 进程清理实测。

2026-10-26 已在服务器完成镜像构建、可见/无头浏览器自检、授权任务启动、真实 VNC 协议连通和终止后的进程清理检查，详见 [Docker 授权修复记录](Docker授权修复-2026-10-26.md)。微软账号最终登录和会话写入仍需用户在远程窗口完成验证。
