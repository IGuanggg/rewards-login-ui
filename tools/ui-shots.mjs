/**
 * UI 截图生成器（可重复执行）
 * ------------------------------------------------------------
 * 用法：node tools/ui-shots.mjs
 * 在临时目录造一个结构完整的假实例，用 Chrome DevTools Protocol 走完整流程
 * （解锁 → 环境自检 → 连接 → 账号授权 → 日志 → 设置 → 浅色 → 窄屏），
 * 把截图写进 docs/shots/。不会触碰真实仓库与真实账号。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'shots')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-ui-'))
const BOT = path.join(SANDBOX, 'Microsoft-Rewards-Script')
const PANEL_CFG = path.join(SANDBOX, 'panel-config.json')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const CDP_PORT = 9339
const PANEL_PORT = 4174
const BASE = `http://127.0.0.1:${PANEL_PORT}`
const TOKEN = 'demo-panel-password'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/* ────────── 夹具 ────────── */

function buildFakeInstance() {
    fs.rmSync(BOT, { recursive: true, force: true })
    for (const dir of [
        'scripts/main',
        'dist',
        'sessions',
        'node_modules/patchright',
        'node_modules/fingerprint-generator',
        'node_modules/fingerprint-injector',
        'node_modules/otpauth',
        'node_modules/ghost-cursor-playwright-port'
    ]) {
        fs.mkdirSync(path.join(BOT, dir), { recursive: true })
    }

    fs.writeFileSync(path.join(BOT, 'package.json'), JSON.stringify({ name: 'microsoft-rewards-script', version: '4.3.2' }, null, 4))
    fs.writeFileSync(path.join(BOT, 'scripts', 'utils.js'), 'export const x = 1\n')
    fs.writeFileSync(path.join(BOT, 'dist', 'index.js'), '// built bundle\n')
    fs.writeFileSync(path.join(BOT, 'config.json'), JSON.stringify({ sessionPath: 'sessions', headless: false }, null, 4))
    fs.writeFileSync(
        path.join(BOT, '.env'),
        [
            '# Microsoft Rewards Script - 本地配置',
            'ACCOUNT_1_EMAIL=demo.user@outlook.com',
            'ACCOUNT_1_PASSWORD=DemoPass123',
            'ACCOUNT_1_GEO_LOCALE=US',
            'ACCOUNT_1_LANG_CODE=en-US',
            'ACCOUNT_1_SAVE_FINGERPRINT_MOBILE=true',
            'ACCOUNT_1_SAVE_FINGERPRINT_DESKTOP=true',
            '',
            'ACCOUNT_2_EMAIL=second@example.com',
            'ACCOUNT_2_PASSWORD=pw22',
            'ACCOUNT_2_TOTP_SECRET=JBSWY3DPEHPK3PXP',
            'ACCOUNT_2_PROXY_URL=http://127.0.0.1',
            'ACCOUNT_2_PROXY_PORT=7890',
            'ACCOUNT_2_PROXY_USERNAME=u1',
            'ACCOUNT_2_PROXY_PASSWORD=p1',
            ''
        ].join('\n')
    )

    const db = new DatabaseSync(path.join(BOT, 'sessions', 'sessions.db'))
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT,
        fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))`)
    const state = JSON.stringify({ cookies: Array.from({ length: 18 }, (_, i) => ({ name: `c${i}`, value: 'v' })), origins: [] })
    const now = Date.now()
    const insert = db.prepare('INSERT INTO sessions (email, platform, storage_state, fingerprint, updated_at) VALUES (?,?,?,?,?)')
    insert.run('demo.user@outlook.com', 'mobile', state, null, now - 42 * 60_000)
    insert.run('demo.user@outlook.com', 'desktop', state, null, now - 95 * 60_000)
    insert.run('second@example.com', 'desktop', state, null, now - 26 * 60 * 60_000)
    db.close()

    // 模拟上游 manualLogin：按平台写会话 + 打印上游风格的日志
    fs.writeFileSync(
        path.join(BOT, 'scripts', 'main', 'manualLogin.js'),
        `import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const email = args[args.indexOf('--email') + 1]
const platform = args.includes('--platform') ? args[args.indexOf('--platform') + 1] : 'mobile'
const stamp = () => '[' + new Date().toLocaleString('en-US') + ']'
const say = (tag, msg) => console.log(\`\${stamp()} [\${tag}] [DESKTOP] \${msg}\`)

const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'))
const dir = path.join(process.cwd(), cfg.sessionPath || 'sessions')
fs.mkdirSync(dir, { recursive: true })
const db = new DatabaseSync(path.join(dir, 'sessions.db'))
db.exec("CREATE TABLE IF NOT EXISTS sessions (email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT, fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))")

say('INFO', 'Starting login process')
say('INFO', \`Opening \${platform} manual login for \${email}\`)
say('WARN', 'ACCOUNT_N_SAVE_FINGERPRINT_MOBILE is enabled')
say('INFO', 'Complete the Microsoft sign-in manually in the browser window')
setTimeout(() => {
    say('INFO', 'Rewards page detected; verifying it remains open for 5 seconds...')
}, 700)
setTimeout(() => {
    const targets = platform === 'both' ? ['mobile', 'desktop'] : [platform]
    for (const p of targets) {
        const cookies = Array.from({ length: p === 'mobile' ? 21 : 17 }, (_, i) => ({ name: 'c' + i, value: 'v' }))
        db.prepare('INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?,?,?,?) ON CONFLICT(email, platform) DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at')
          .run(email, p, JSON.stringify({ cookies, origins: [] }), Date.now())
        say('SUCCESS', \`Saved \${p} session for \${email} | cookies=\${cookies.length} | origins=0\`)
    }
    say('SUCCESS', \`Manual login completed for \${email}\`)
    db.close()
    process.exit(0)
}, 1500)
`
    )
}

/* ────────── 面板服务 ────────── */

async function startPanel() {
    const logFd = fs.openSync(path.join(SANDBOX, 'panel.log'), 'a')
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env: { ...process.env, PANEL_PORT: String(PANEL_PORT), PANEL_TOKEN: TOKEN, PANEL_CONFIG: PANEL_CFG, BOT_DIR: '' },
        stdio: ['ignore', logFd, logFd]
    })
    for (let i = 0; i < 80; i++) {
        try {
            const res = await fetch(`${BASE}/api/health`)
            if (res.ok) return child
        } catch {}
        await sleep(200)
    }
    throw new Error('面板服务未启动')
}

/* ────────── CDP ────────── */

class CDP {
    constructor(ws) {
        this.ws = ws
        this.id = 0
        this.pending = new Map()
        ws.addEventListener('message', event => {
            const msg = JSON.parse(event.data)
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id)
                this.pending.delete(msg.id)
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
            }
        })
    }
    send(method, params = {}) {
        const id = ++this.id
        this.ws.send(JSON.stringify({ id, method, params }))
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id)
                    reject(new Error(`timeout ${method}`))
                }
            }, 30000)
        })
    }
}

async function getJson(url, options) {
    for (let i = 0; i < 60; i++) {
        try {
            const res = await fetch(url, options)
            if (res.ok) return await res.json()
        } catch {}
        await sleep(250)
    }
    throw new Error(`chrome 未就绪：${url}`)
}

async function openPage(url, { width = 1440, height = 1040 } = {}) {
    const target = await getJson(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true })
        ws.addEventListener('error', reject, { once: true })
    })
    const cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
    return { cdp, ws }
}

const evaluate = (cdp, expression) => cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })

async function shot(cdp, name, wait = 1200) {
    await sleep(wait)
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'))
    console.log('  saved', name)
}

/* ────────── 主流程 ────────── */

async function main() {
    fs.rmSync(OUT, { recursive: true, force: true })
    fs.mkdirSync(OUT, { recursive: true })
    buildFakeInstance()

    const panel = await startPanel()
    const profile = path.join(SANDBOX, 'chrome-profile')
    const chrome = spawn(
        CHROME,
        ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--hide-scrollbars', '--window-size=1440,1040', 'about:blank'],
        { stdio: 'ignore' }
    )

    try {
        await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`)
        const page = await openPage(`${BASE}/`)
        await sleep(1600)

        // 1. 解锁页
        await shot(page.cdp, 'unlock.png', 800)

        // 2. 输入密码 → 首次设置（未连接实例）
        await evaluate(page.cdp, `document.querySelector('#unlock-token').value = ${JSON.stringify(TOKEN)}; document.querySelector('#btn-unlock').click(); true`)
        await sleep(1800)
        await shot(page.cdp, 'setup.png', 600)

        // 3. 填路径 → 自检 → 连接
        await evaluate(page.cdp, `document.querySelector('#setup-path').value = ${JSON.stringify(BOT)}; document.querySelector('#btn-setup-connect').click(); true`)
        await sleep(2600)
        await shot(page.cdp, 'dashboard.png', 600)

        await evaluate(page.cdp, `document.querySelector('#btn-add-account').click(); true`)
        await sleep(500)
        await shot(page.cdp, 'add-account.png', 300)
        await evaluate(page.cdp, `document.querySelector('#btn-close-form').click(); true`)
        await sleep(400)
        await shot(page.cdp, 'dashboard.png', 300)

        // 4. 授权弹窗（运行中 → 完成）
        await evaluate(page.cdp, `document.querySelector('.account-item [data-act="authorize"]').click(); true`)
        await sleep(700)
        await evaluate(page.cdp, `document.querySelector('#btn-start-login').click(); true`)
        await sleep(1000)
        await shot(page.cdp, 'authorize-running.png', 100)
        await sleep(3000)
        await shot(page.cdp, 'authorize-done.png', 300)

        // 5. 失败路径：脚本正常退出但没有写会话 → 必须显示为失败，而不是“登录成功”
        fs.writeFileSync(
            path.join(BOT, 'scripts', 'main', 'manualLogin.js'),
            `console.log('[INFO] Starting login process')
console.log('[INFO] Complete the Microsoft sign-in manually in the browser window')
console.log('[WARN] browser window was closed before the Rewards page stabilized')
process.exit(0)
`
        )
        await evaluate(page.cdp, `document.querySelector('#btn-start-login').click(); true`)
        await sleep(2200)
        await shot(page.cdp, 'authorize-failed.png', 400)

        // 6. 运行日志
        await evaluate(page.cdp, `document.querySelector('#dlg-login').close(); document.querySelector('[data-tab="logs"]').click(); true`)
        await shot(page.cdp, 'logs.png', 1200)

        // 7. 环境与设置
        await evaluate(page.cdp, `document.querySelector('[data-tab="settings"]').click(); true`)
        await shot(page.cdp, 'settings.png', 1500)

        // 8. 浅色主题
        await evaluate(page.cdp, `document.documentElement.dataset.theme='light'; localStorage.setItem('rwd.theme','light'); document.querySelector('[data-tab="accounts"]').click(); true`)
        await shot(page.cdp, 'dashboard-light.png', 1400)

        // 9. 窄屏
        await evaluate(page.cdp, `document.documentElement.dataset.theme='dark'; true`)
        await page.cdp.send('Emulation.setDeviceMetricsOverride', { width: 414, height: 940, deviceScaleFactor: 2, mobile: true })
        await shot(page.cdp, 'mobile.png', 1400)

        page.ws.close()
        console.log('\n截图已写入 docs/shots/')
    } finally {
        chrome.kill()
        panel.kill()
        await sleep(300)
        fs.rmSync(SANDBOX, { recursive: true, force: true })
    }
}

main().catch(error => {
    console.error('截图失败：', error)
    process.exitCode = 1
})
