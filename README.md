# Rewards 控制台

给 [TheNetsky/Microsoft-Rewards-Script](https://github.com/TheNetsky/Microsoft-Rewards-Script) 用的**本地登录面板**：不用再手改 `.env`、不用记命令行参数，在网页上填账号 → 点「授权」→ 在弹出的浏览器里完成微软登录 → 会话自动写回 `sessions.db`，之后签到时直接复用。

界面风格参考 [linux-do/cdk](https://github.com/linux-do/cdk)（居中单列入口、液态按钮、极细描边、弹窗式交互），零构建、零依赖，只用 Node.js 内置模块。

![解锁页](docs/shots/unlock.png)

---

## 它解决什么

原脚本的手动登录是这样的：

```bash
cd Microsoft-Rewards-Script
# 先手改 .env 填 ACCOUNT_1_EMAIL / ACCOUNT_1_PASSWORD / ...
npm run manual-login -- your@email.com --platform mobile
```

每次加账号、改密码、重登都要重复上面这套。本面板把它搬到浏览器里：

| 原来的操作 | 现在 |
| --- | --- |
| 手工编辑 `.env`，容易写错键名、漏字段 | 表单填写，实时校验，写入前自动备份 |
| 记 `--platform mobile/desktop/both`、`--fresh` | 单选胶囊，一眼看清 |
| 终端里盯日志猜进度 | 子进程输出经 SSE 实时推送到页面，按级别着色 |
| 不知道会话到底存没存 | **以 `sessions.db` 是否真的写入为准**，逐平台显示 cookie 数与时间 |
| 环境缺依赖要跑到报错才知道 | 首次进入先做环境自检（仓库/Node/依赖/Chromium/构建） |

---

## 快速开始

### 1. 放进脚本仓库（推荐）

```text
Microsoft-Rewards-Script/
├── src/
├── scripts/
├── config.json
├── .env
└── rewards-login-ui/          ← 放这里
    ├── server.js
    └── public/
```

```bash
cd Microsoft-Rewards-Script/rewards-login-ui
node server.js
```

终端会打印访问密码：

```text
  地址        http://127.0.0.1:4173
  实例目录    D:\Microsoft-Rewards-Script
  访问密码    xxxxxxxxxxxxxxxx
              （来源：generated，已写入 config.json）
```

打开 <http://127.0.0.1:4173>，输入密码进入面板。

### 2. 放在任意位置

```bash
node D:\tools\rewards-login-ui\server.js
```

进入面板后会自动探测上级目录；探测不到就手动填写脚本仓库根目录，面板会先做环境自检，通过后才允许连接。

### 3. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PANEL_PORT` | `4173` | 监听端口 |
| `PANEL_HOST` | `127.0.0.1` | 监听地址 |
| `PANEL_TOKEN` | 自动生成 | 面板访问密码（优先于 `config.json`） |
| `PANEL_NO_AUTH` | 关 | 设为 `1` 关闭面板鉴权（界面会明确警告） |
| `PANEL_CONFIG` | `./config.json` | 面板自身配置路径 |
| `BOT_DIR` | 无 | 预置脚本仓库路径 |

> ⚠️ 面板会读写 `.env` 并启动浏览器进程，**只在本机使用**。不要暴露到局域网或公网；真要暴露必须先设 `PANEL_TOKEN` 并加反向代理 TLS。

---

## 界面

### 首次设置：环境自检

![环境自检](docs/shots/setup.png)

逐项检查上游仓库、Node 版本、依赖、Chromium 内核、构建产物、config.json 与会话库。**阻断项不通过就不会连接，也不会写任何文件。**

### 账号授权

![工作台](docs/shots/dashboard.png)

- 左侧列出 `.env` 里全部 `ACCOUNT_N_*`，带会话状态：绿色=已保存会话（cookie 数 + 时间），灰色=未授权。
- 每行四个动作：**授权**、**签到**（走 Control API）、**编辑**、**删除**。
- 右侧表单新增/编辑账号：邮箱、密码、TOTP、国家/地区、语言；代理、备用邮箱、指纹开关收在「高级选项」。
- 编辑时密码、TOTP、备用邮箱、代理、**指纹开关**留空/未改动即保持原值。

### 授权结果以会话文件为准

| 成功 | 失败（脚本打印了成功日志、退出码 0，但没写会话） |
| --- | --- |
| ![授权成功](docs/shots/authorize-done.png) | ![授权失败](docs/shots/authorize-failed.png) |

四种终态：`done`（全部平台写入）/ `partial`（两端只写了一端）/ `failed`（非零退出码，或正常退出但没写会话）/ `cancelled`（用户终止）。

判定依据是该账号该平台的 `updated_at` **严格大于任务开始前的基线**，所以任务前就存在的旧会话不会被误判为「本次成功」。

### 运行日志

![运行日志](docs/shots/logs.png)

### 环境与设置

![环境与设置](docs/shots/settings.png)

三类配置彼此独立：**① 面板访问**（改密码）、**② 微软账号授权**（仓库路径 + 自检）、**③ 签到运行**（Control API，可选）。

浅色与窄屏：

| 浅色 | 移动端 |
| --- | --- |
| ![浅色](docs/shots/dashboard-light.png) | ![移动端](docs/shots/mobile.png) |

---

## 安全模型

| 项 | 做法 |
| --- | --- |
| 面板访问 | 独立访问密码 + HttpOnly/SameSite=Strict Cookie（HMAC-SHA256，12h）；退出登录会使所有旧 Cookie 立即失效；连续 5 次错误锁 30 秒 |
| 接口保护 | 除 `/api/auth/*` 与 `/api/health` 外所有 `/api/*`（含 SSE）都要求有效会话，否则 401 |
| 与上游令牌的关系 | Control API 令牌是独立字段，只用于请求上游 API，**不能**用来访问面板 |
| 凭据写入 | 所有字段拒绝换行/控制字符；引号处理与上游 `loadEnvFile` 解析规则一致；写入前备份 `.env.panel.bak`（0600） |
| 目录校验 | 连接与每个写入入口都校验上游仓库结构，非法目录 422 且不创建文件 |
| 会话读取 | `sessions.db` 只读，只读元信息（时间、cookie 数量），从不导出 Cookie 内容 |
| 密码回显 | 只回传掩码（`Te••••23`），编辑时不回填明文 |

---

## 可选的 Control API 接入

「签到」按钮依赖上游自带的 Control API；账号授权**不需要**它。

```bash
# 1) 生成令牌
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2) 写入 .env（注意：这是上游 API_TOKEN，不是面板密码）
API_TOKEN=粘贴上一步生成的令牌
API_HOST=127.0.0.1
API_PORT=3010

# 3) 启动
npm run api
```

回到面板「环境与设置 → ③ 签到运行」，填地址与令牌并保存。面板只会调用 `/health`、`/start`、`/stop`。状态分为在线 / 令牌无效 / 接口异常 / 未配置四态，401 不会被显示成「在线」。

---

## 它到底改了哪些文件

| 路径 | 行为 |
| --- | --- |
| `<仓库>/.env` | 只增删改 `ACCOUNT_N_*` 行；注释、其他变量、账号顺序一律保留；写入前备份 `.env.panel.bak` |
| `<仓库>/sessions/sessions.db`（或 `config.sessionPath` 指定处） | **只读** |
| `rewards-login-ui/config.json` | 面板自身的访问密码、实例路径、Control API 设置（0600） |
| 浏览器 `localStorage` | 仅主题偏好；退出时清空 |

面板不创建上游的 `config.json`，也不会上传任何数据。

---

## 测试与自测

```bash
# 23 项自动化回归（临时沙箱、虚构数据，跑完自动清理）
node tools/acceptance.mjs

# 重新生成 docs/shots 下的全部截图
node tools/ui-shots.mjs
```

回归覆盖：鉴权拦截、错误密码、配置覆盖、目录校验、换行注入、特殊字符往返、指纹保留、邮箱校验、重复邮箱、备份、自定义 sessionPath、四种任务终态、Control API 三态、退出作废会话、面板重启后会话仍在、再次授权刷新时间戳。

**真实账号链路需要你自己跑一遍**（自动化无法代劳）：

1. `node server.js` → 输入终端打印的密码；
2. 首次设置页填仓库路径，确认自检全绿（缺依赖按提示 `npm install` / `npx patchright install chromium`）；
3. 添加账号 → 点「授权」→ 在弹出浏览器里完成微软登录；
4. 弹窗出现「移动端 已写入 · N cookies」即成功；显示「未写入」时会给出原因；
5. 关闭面板再启动，账号行仍显示「移动端 · N cookies · x 分钟前」= 会话可复用；
6. 两端都要：选「两端都授权」，只完成一端会显示 `partial` 并指出缺哪个平台；
7. 建议顺手试一次失败路径：授权时直接关掉浏览器窗口，面板应显示失败而不是成功。

---

## 常见问题

**探测不到实例目录？**
把 `rewards-login-ui` 放进仓库根目录，或在首次设置页手填绝对路径。校验要求存在 `package.json`（name 为 microsoft-rewards-script）、`scripts/main/manualLogin.js`、`scripts/utils.js`。

**忘了面板密码？**
看终端启动时打印的那一行，或读 `rewards-login-ui/config.json` 里的 `panelToken`（也可用 `PANEL_TOKEN` 环境变量覆盖）。

**点「授权」后浏览器没出现？**
看环境自检的提示，通常是缺依赖或缺 Chromium 内核：

```bash
cd <仓库>
npm install
npx patchright install chromium
npm run build
```

**为什么移动端和桌面端要分别授权？**
上游用不同的浏览器指纹与会话文件区分两端，奖励任务也分 PC / Mobile 两套，两边都授权才能拿满。

**TOTP 密钥怎么拿？**
微软安全设置 →「管理登录方式」→ 添加验证器应用 → 二维码页面选「手动输入代码」，把那段密钥填进表单。

**面板重启后任务记录还在吗？**
「最近授权任务」只保留在当前面板进程内存里，重启即清空（与上游 Control API 行为一致）；但**会话文件是持久的**，重启后账号行依然显示已授权状态。

---

## 目录结构

```text
rewards-login-ui/
├── server.js              # 零依赖 HTTP 服务：鉴权、仓库校验、.env 读写、sessions.db 只读、子进程与 SSE
├── public/
│   ├── index.html         # 解锁页 + 首次设置 + 控制台 + 弹窗
│   ├── css/styles.css     # 设计令牌、背景氛围、液态按钮、响应式
│   └── js/app.js          # 视图切换、表单、SSE 日志流、主题
├── tools/
│   ├── acceptance.mjs     # 23 项回归测试
│   └── ui-shots.mjs       # 截图生成
├── docs/
│   ├── 修复验证报告-2026-10-22.md
│   └── shots/
├── config.json            # 运行时生成
└── README.md
```

## 许可

与上游脚本保持一致，仅供本机自用。使用自动化脚本可能违反微软服务条款，账号风险自负。
