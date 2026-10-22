/**
 * 面板验收回归脚本（可重复执行，隔离于临时目录）
 * ------------------------------------------------------------
 * 用法：node tools/acceptance.mjs
 * 覆盖验收报告提到的 8 个失败项 + 3 个既有通过项，全部用虚构数据。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-acc-'))
const BOT = path.join(SANDBOX, 'bot')
const CFG = path.join(SANDBOX, 'panel-config.json')
const PORT = 4399
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-panel-token-123456'

const results = []
let server = null
let cookie = ''

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function record(id, ok, expected, actual) {
    results.push({ id, status: ok ? 'PASS' : 'FAIL', expected, actual })
    console.log(`${ok ? '  PASS' : '  FAIL'}  ${id}${ok ? '' : '  ← ' + JSON.stringify(actual)}`)
}

/* ── 夹具 ── */

function makeBotRepo({ sessionPath = 'sessions', withSessions = true } = {}) {
    fs.rmSync(BOT, { recursive: true, force: true })
    fs.mkdirSync(path.join(BOT, 'scripts', 'main'), { recursive: true })
    fs.writeFileSync(
        path.join(BOT, 'package.json'),
        JSON.stringify({ name: 'microsoft-rewards-script', version: '0.0.0' }, null, 2)
    )
    fs.writeFileSync(path.join(BOT, 'scripts', 'utils.js'), 'export const x = 1\n')
    fs.writeFileSync(path.join(BOT, 'config.json'), JSON.stringify({ sessionPath, headless: false }, null, 4))
    fs.writeFileSync(path.join(BOT, '.env'), 'ACCOUNT_1_EMAIL=first@example.com\nACCOUNT_1_PASSWORD=pw\n')
    if (withSessions) {
        const dir = path.join(BOT, sessionPath)
        fs.mkdirSync(dir, { recursive: true })
        const db = new DatabaseSync(path.join(dir, 'sessions.db'))
        db.exec(`CREATE TABLE IF NOT EXISTS sessions (
            email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT,
            fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))`)
        db.close()
    }
    // 默认的登录脚本：不写入会话，只打印一行普通日志
    writeLoginScript('nolog')
}

/** mode: nolog | ok | both | crash | hang | partial */
function writeLoginScript(mode) {
    // 模拟上游：按 config.json 的 sessionPath 落库
    const preamble = `
        import fs from 'node:fs'
        import path from 'node:path'
        import { DatabaseSync } from 'node:sqlite'
        const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'))
        const dir = path.join(process.cwd(), cfg.sessionPath || 'sessions')
        fs.mkdirSync(dir, { recursive: true })
        const db = new DatabaseSync(path.join(dir, 'sessions.db'))
        db.exec("CREATE TABLE IF NOT EXISTS sessions (email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT, fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))")
        const save = (platform, cookies) => db.prepare('INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?,?,?,?) ON CONFLICT(email, platform) DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at')
            .run('first@example.com', platform, JSON.stringify({ cookies }), Date.now())
    `
    const body = {
        nolog: `console.log('[INFO] did nothing at all')`,
        ok: `${preamble}\n save('mobile', [{ name: 'a', value: '1' }, { name: 'b', value: '2' }])\n console.log('[SUCCESS] Saved mobile session for first@example.com')`,
        both: `${preamble}\n save('mobile', [{ name: 'a', value: '1' }])\n save('desktop', [{ name: 'a', value: '1' }])\n console.log('[SUCCESS] Saved both sessions')`,
        partial: `${preamble}\n save('mobile', [{ name: 'a', value: '1' }])\n console.log('[SUCCESS] Saved mobile only')`,
        crash: `console.error('[ERROR] boom'); process.exit(1)`,
        hang: `console.log('[INFO] waiting'); setInterval(() => {}, 1000)`
    }[mode]
    fs.writeFileSync(path.join(BOT, 'scripts', 'main', 'manualLogin.js'), body + '\n')
}

/* ── HTTP ── */

async function call(pathname, { method = 'GET', body, auth = true, raw = false } = {}) {
    const headers = {}
    if (body) headers['Content-Type'] = 'application/json'
    if (auth && cookie) headers.Cookie = cookie
    const response = await fetch(`${BASE}${pathname}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    })
    if (raw) return response
    let data = {}
    try {
        data = await response.json()
    } catch {}
    return { status: response.status, data, headers: response.headers }
}

/* ── 启动 ── */

async function startServer(extraEnv = {}) {
    // 用文件承接子进程输出：受限环境下管道 stdio 可能不可用
    const logFile = path.join(SANDBOX, 'server.log')
    const logFd = fs.openSync(logFile, 'a')
    const env = {
        ...process.env,
        PANEL_PORT: String(PORT),
        PANEL_CONFIG: CFG,
        BOT_DIR: '',
        ...extraEnv
    }
    if (!Object.prototype.hasOwnProperty.call(extraEnv, 'PANEL_TOKEN')) env.PANEL_TOKEN = TOKEN

    server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        cwd: ROOT,
        env,
        stdio: ['ignore', logFd, logFd]
    })
    server.on('error', error => console.error('[server spawn]', error.message))

    let lastError = null
    for (let i = 0; i < 80; i++) {
        try {
            const response = await fetch(`${BASE}/api/health`)
            if (response.ok) return
            lastError = new Error(`HTTP ${response.status}`)
        } catch (error) {
            lastError = error
        }
        await sleep(250)
    }
    console.error('最后错误：', lastError?.message, lastError?.cause?.message || '')
    console.error('服务日志：\n' + fs.readFileSync(logFile, 'utf8'))
    throw new Error('服务未启动')
}

let activeToken = TOKEN

async function login() {
    const response = await call('/api/auth/login', { method: 'POST', body: { token: activeToken }, auth: false, raw: true })
    const setCookie = response.headers.get('set-cookie') || ''
    cookie = setCookie.split(';')[0]
    if (!cookie) throw new Error('登录未返回 Cookie')
}

/* ── 用例 ── */

async function main() {
    makeBotRepo()
    await startServer()

    /* 0. 未认证时接口必须被拦截 */
    {
        const accounts = await call('/api/accounts', { auth: false })
        const cfg = await call('/api/config', { method: 'PUT', body: { controlToken: 'hijack' }, auth: false })
        const event = await call('/api/events', { auth: false, raw: true })
        record(
            'auth_required',
            accounts.status === 401 && cfg.status === 401 && event.status === 401,
            '未认证请求一律 401',
            { accounts: accounts.status, config: cfg.status, sse: event.status }
        )
    }

    /* 1. 错误密码 */
    {
        const bad = await call('/api/auth/login', { method: 'POST', body: { token: 'wrong' }, auth: false })
        record('auth_wrong_password', bad.status === 401, '错误密码 401', { http: bad.status })
    }

    await login()

    /* 2. 令牌不能通过未认证接口被覆盖（现在所有写接口都需要认证） */
    {
        const readPanelToken = () =>
            fs.existsSync(CFG) ? JSON.parse(fs.readFileSync(CFG, 'utf8')).panelToken : TOKEN
        const before = readPanelToken()
        const attempt = await call('/api/config', { method: 'PUT', body: { controlToken: 'x' }, auth: false })
        const after = readPanelToken()
        record(
            'auth_config_overwrite',
            attempt.status === 401 && before === after,
            '未认证无法改动配置',
            { http: attempt.status, changed: before !== after }
        )
    }

    /* 3. 非法目录必须被拒绝，且不得写入 .env */
    {
        const junk = path.join(SANDBOX, 'plain-folder')
        fs.mkdirSync(junk, { recursive: true })
        const res = await call('/api/config', { method: 'PUT', body: { botDir: junk } })
        const envCreated = fs.existsSync(path.join(junk, '.env'))
        record(
            'reject_non_repository_directory',
            res.status === 422 && !envCreated,
            '普通文件夹 422 且不创建文件',
            { http: res.status, envCreated }
        )
    }

    /* 4. 合法目录可以连接 */
    {
        const res = await call('/api/config', { method: 'PUT', body: { botDir: BOT } })
        record('accept_valid_repository', res.status === 200, '合法仓库 200', { http: res.status })
    }

    /* 5. 凭据换行注入必须被拒绝 */
    {
        const res = await call('/api/accounts', {
            method: 'POST',
            body: { index: 3, email: 'inject@example.com', password: 'dummy\nREVIEW_INJECTED=1' }
        })
        const env = fs.readFileSync(path.join(BOT, '.env'), 'utf8')
        record(
            'reject_newlines_in_credentials',
            res.status === 422 && !env.includes('REVIEW_INJECTED'),
            '含换行密码 422 且无注入行',
            { http: res.status, injected: env.includes('REVIEW_INJECTED') }
        )
    }

    /* 6. 特殊字符密码：写入后仍能被上游规则读回 */
    {
        const tricky = 'p@ss w=rd "#1"'
        const res = await call('/api/accounts', {
            method: 'POST',
            body: { index: 4, email: 'special@example.com', password: tricky }
        })
        const env = fs.readFileSync(path.join(BOT, '.env'), 'utf8')
        const line = env.split(/\r?\n/).find(l => l.startsWith('ACCOUNT_4_PASSWORD='))
        // 模拟上游 loadEnvFile：去首尾空白，剥掉成对引号
        let value = line.slice('ACCOUNT_4_PASSWORD='.length).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        record(
            'roundtrip_special_characters',
            res.status === 201 && value === tricky,
            '特殊字符原样往返',
            { http: res.status, parsed: value, expected: tricky }
        )
    }

    /* 7. 编辑账号不得改写指纹开关 */
    {
        fs.appendFileSync(path.join(BOT, '.env'), 'ACCOUNT_5_EMAIL=fp@example.com\nACCOUNT_5_SAVE_FINGERPRINT_MOBILE=false\nACCOUNT_5_SAVE_FINGERPRINT_DESKTOP=true\n')
        const res = await call('/api/accounts', { method: 'POST', body: { index: 5, email: 'fp@example.com', geoLocale: 'CN' } })
        const env = fs.readFileSync(path.join(BOT, '.env'), 'utf8')
        const mobileLine = env.split(/\r?\n/).find(l => l.startsWith('ACCOUNT_5_SAVE_FINGERPRINT_MOBILE='))
        record(
            'preserve_fingerprint_settings',
            res.status === 200 && mobileLine === 'ACCOUNT_5_SAVE_FINGERPRINT_MOBILE=false',
            '编辑后移动端指纹仍为 false',
            { http: res.status, line: mobileLine }
        )
    }

    /* 8. 校验通过项：非法邮箱 / 重复邮箱 / 备份 */
    {
        const badEmail = await call('/api/accounts', { method: 'POST', body: { email: 'not-an-email' } })
        record('invalid_email_validation', badEmail.status === 422, '非法邮箱 422', { http: badEmail.status })

        const dup = await call('/api/accounts', { method: 'POST', body: { index: 9, email: 'first@example.com' } })
        record('duplicate_email_validation', dup.status === 409, '重复邮箱 409', { http: dup.status })

        const backup = fs.existsSync(path.join(BOT, '.env.panel.bak'))
        record('env_backup', backup, '写入前生成 .env.panel.bak', { backupExists: backup })
    }

    /* 9. 自定义 sessionPath 必须被识别 */
    {
        makeBotRepo({ sessionPath: 'custom_sessions' })
        const db = new DatabaseSync(path.join(BOT, 'custom_sessions', 'sessions.db'))
        db.prepare('INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?,?,?,?)').run(
            'first@example.com',
            'mobile',
            JSON.stringify({ cookies: [{ name: 'a' }] }),
            Date.now()
        )
        db.close()
        await call('/api/config', { method: 'PUT', body: { botDir: BOT } })
        const accounts = await call('/api/accounts')
        const mobile = accounts.data.accounts?.[0]?.sessions?.mobile
        record(
            'custom_session_path',
            accounts.data.sessions?.exists === true && Boolean(mobile) && accounts.data.sessions.configured === 'custom_sessions',
            '读取 custom_sessions/sessions.db',
            { exists: accounts.data.sessions?.exists, configured: accounts.data.sessions?.configured, mobile }
        )
    }

    /* 10. 零退出码但没写会话 → 必须失败 */
    {
        writeLoginScript('nolog')
        await sleep(50)
        const start = await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'mobile' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        record(
            'require_saved_session_for_success',
            start.status === 202 && job?.state === 'failed' && job?.exitCode === 0,
            '未写会话 → failed，即使退出码 0',
            { http: start.status, state: job?.state, exitCode: job?.exitCode }
        )
    }

    /* 11. 真正写入会话 → done */
    {
        writeLoginScript('ok')
        await sleep(50)
        await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'mobile' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        record(
            'success_requires_saved_session',
            job?.state === 'done' && job?.verification?.saved?.includes('mobile'),
            '写入会话 → done 且标记 mobile',
            { state: job?.state, verification: job?.verification }
        )
    }

    /* 12. 两端只写一端 → partial */
    {
        writeLoginScript('partial')
        await sleep(50)
        await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'both' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        record(
            'both_platform_partial_detection',
            job?.state === 'partial' && job?.verification?.missing?.includes('desktop'),
            'both 只存一端 → partial',
            { state: job?.state, verification: job?.verification }
        )
    }

    /* 13. 终止任务 → cancelled */
    {
        writeLoginScript('hang')
        await sleep(50)
        await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'mobile' } })
        await sleep(700)
        await call('/api/login/stop', { method: 'POST', body: { email: 'first@example.com' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        record('cancel_marks_job_cancelled', job?.state === 'cancelled', '终止 → cancelled', { state: job?.state })
    }

    /* 14. 失败进程 → failed */
    {
        writeLoginScript('crash')
        await sleep(50)
        await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'mobile' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        record('nonzero_exit_failed', job?.state === 'failed' && job?.exitCode === 1, '退出码 1 → failed', { state: job?.state, exitCode: job?.exitCode })
    }

    /* 15. Control API 401 不能算在线 */
    {
        const fake = await startControlApi(18010, 401)
        await call('/api/config', { method: 'PUT', body: { controlApi: 'http://127.0.0.1:18010', controlToken: 'nope' } })
        const res = await call('/api/state')
        record(
            'control_health_401',
            res.data.control?.status === 'unauthorized',
            '401 → unauthorized 而非 online',
            { control: res.data.control }
        )
        fake.kill()
    }

    /* 16. Control API 正常 → online，可启动运行 */
    {
        const fake = await startControlApi(18011, 200)
        await call('/api/config', { method: 'PUT', body: { controlApi: 'http://127.0.0.1:18011', controlToken: 'x' } })
        const res = await call('/api/state')
        const run = await call('/api/control/start', { method: 'POST', body: { payload: {} } })
        record(
            'control_health_ok',
            res.data.control?.status === 'online' && run.status === 202,
            '200 → online 且 /start 透传 202',
            { control: res.data.control?.status, start: run.status }
        )
        fake.kill()
    }

    /* 17. 未配置 Control API 时接口层拒绝 */
    {
        await call('/api/config', { method: 'PUT', body: { controlApi: '', controlToken: '' } })
        const res = await call('/api/control/start', { method: 'POST', body: {} })
        record('control_unconfigured', res.status === 503, '未配置 → 503 并说明', { http: res.status, error: res.data.error })
    }

    /* 18. 退出后旧 Cookie 不能继续使用 */
    {
        const saved = cookie
        await call('/api/auth/logout', { method: 'POST' })
        cookie = saved
        const res = await call('/api/accounts')
        record('logout_invalidates_session', res.status === 401, '退出后旧 Cookie 401', { http: res.status })
    }

    /* 19. 面板重启后，已保存的会话仍可被读取（面板自身无状态，不依赖重启前内存） */
    {
        cookie = ''
        await login() // 上一项用例刻意让旧 Cookie 失效，这里重新登录
        const before = await call('/api/accounts')
        const beforeMobile = before.data.accounts?.[0]?.sessions?.mobile?.updatedAt

        server.kill()
        await sleep(600)
        cookie = ''
        await startServer()
        await login()

        const after = await call('/api/accounts')
        const afterMobile = after.data.accounts?.[0]?.sessions?.mobile?.updatedAt
        record(
            'session_survives_panel_restart',
            Boolean(beforeMobile) && beforeMobile === afterMobile,
            '重启面板后会话仍在且时间戳一致',
            { before: beforeMobile, after: afterMobile }
        )
    }

    /* 20. 再次授权会刷新会话时间戳（可复用的前提是能刷新） */
    {
        writeLoginScript('ok')
        await sleep(50)
        const first = await call('/api/accounts')
        const t1 = first.data.accounts?.[0]?.sessions?.mobile?.updatedAt
        await sleep(1100)
        await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'mobile' } })
        let job = null
        for (let i = 0; i < 60; i++) {
            const res = await call('/api/login/job?email=first@example.com')
            job = res.data.job
            if (job && job.state !== 'running') break
            await sleep(150)
        }
        const second = await call('/api/accounts')
        const t2 = second.data.accounts?.[0]?.sessions?.mobile?.updatedAt
        record(
            'relogin_refreshes_session',
            job?.state === 'done' && t2 > t1,
            '再次授权刷新 updated_at',
            { state: job?.state, before: t1, after: t2 }
        )
    }

    /* 21. 8 位密码保存后，重启（且不用环境变量覆盖）仍能登录 */
    {
        const shortToken = 'abcd1234'
        const changed = await call('/api/auth/password', { method: 'POST', body: { token: shortToken } })
        const stored = JSON.parse(fs.readFileSync(CFG, 'utf8')).panelToken
        server.kill()
        await sleep(600)
        cookie = ''
        await startServer({ PANEL_TOKEN: '' })
        const still = JSON.parse(fs.readFileSync(CFG, 'utf8')).panelToken
        const loginRes = await call('/api/auth/login', { method: 'POST', body: { token: shortToken }, auth: false, raw: true })
        const setCookie = loginRes.headers.get('set-cookie') || ''
        cookie = setCookie.split(';')[0]
        activeToken = shortToken
        const accounts = await call('/api/accounts')
        record(
            'short_password_survives_restart',
            changed.status === 200 && stored === shortToken && still === shortToken && loginRes.status === 200 && accounts.status === 200,
            '8 位密码保存、重启、再登录都成功，且不会被换成新密码',
            { save: changed.status, stored, afterRestart: still, login: loginRes.status, accounts: accounts.status }
        )
    }

    /* 22. 退出后的旧 Cookie，重启服务也不能重新生效 */
    {
        const stale = cookie
        const logout = await call('/api/auth/logout', { method: 'POST' })
        const afterLogout = await call('/api/accounts')
        server.kill()
        await sleep(600)
        cookie = stale
        await startServer({ PANEL_TOKEN: '' })
        const afterRestart = await call('/api/accounts')
        const anonymousLogout = await call('/api/auth/logout', { method: 'POST', auth: false })
        record(
            'revoked_cookie_stays_dead_after_restart',
            logout.status === 200 && afterLogout.status === 401 && afterRestart.status === 401 && anonymousLogout.status === 401,
            '退出后旧 Cookie 在重启前后都是 401，未登录也不能代他人退出',
            { logout: logout.status, afterLogout: afterLogout.status, afterRestart: afterRestart.status, anonymousLogout: anonymousLogout.status }
        )
    }

    /* 23. 空 Cookie 或损坏会话不能算授权成功 */
    {
        cookie = ''
        await login()
        const writeBad = kind => {
            fs.writeFileSync(
                path.join(BOT, 'scripts', 'main', 'manualLogin.js'),
                `import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config.json'), 'utf8'))
const dir = path.join(process.cwd(), cfg.sessionPath || 'sessions')
const db = new DatabaseSync(path.join(dir, 'sessions.db'))
db.exec("CREATE TABLE IF NOT EXISTS sessions (email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT, fingerprint TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))")
const payload = ${kind === 'empty' ? "JSON.stringify({ cookies: [] })" : "'not-json'"}
db.prepare('INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?,?,?,?) ON CONFLICT(email, platform) DO UPDATE SET storage_state = excluded.storage_state, updated_at = excluded.updated_at')
  .run('first@example.com', 'desktop', payload, Date.now())
console.log('[SUCCESS] Saved desktop session')
`
            )
        }
        const outcomes = []
        for (const kind of ['empty', 'broken']) {
            writeBad(kind)
            await sleep(40)
            await call('/api/login/start', { method: 'POST', body: { email: 'first@example.com', platform: 'desktop' } })
            let job = null
            for (let i = 0; i < 60; i++) {
                const res = await call('/api/login/job?email=first@example.com')
                job = res.data.job
                if (job && job.state !== 'running') break
                await sleep(150)
            }
            outcomes.push({ kind, state: job?.state })
        }
        record(
            'empty_or_broken_session_is_not_success',
            outcomes.every(item => item.state === 'failed'),
            '空 Cookie 和无法解析的会话都判失败',
            outcomes
        )
    }

    /* 24. 自检：缺配置不算就绪；明确指定的路径不能被已连接实例盖掉 */
    {
        const other = path.join(SANDBOX, 'other-bot')
        fs.mkdirSync(path.join(other, 'scripts', 'main'), { recursive: true })
        fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'microsoft-rewards-script' }))
        fs.writeFileSync(path.join(other, 'scripts', 'utils.js'), 'export const x = 1\n')
        fs.writeFileSync(path.join(other, 'scripts', 'main', 'manualLogin.js'), 'console.log(1)\n')
        fs.writeFileSync(path.join(other, 'config.json'), '{}\n')
        const probed = await call(`/api/preflight?botDir=${encodeURIComponent(other)}`)
        const configCheck = probed.data.checks?.find(item => item.id === 'config')
        record(
            'preflight_uses_requested_path_and_requires_sessionpath',
            probed.data.botDir === other && probed.data.authorizeReady === false && configCheck?.ok === false,
            '检查 B 时返回 B，且缺少 sessionPath 不算授权就绪',
            { botDir: probed.data.botDir, authorizeReady: probed.data.authorizeReady, config: configCheck }
        )
    }

    /* 汇总 */
    const failed = results.filter(r => r.status === 'FAIL')
    const summary = {
        date: new Date().toISOString().slice(0, 10),
        sandbox: SANDBOX,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.length,
        results
    }
    fs.writeFileSync(path.join(ROOT, 'docs', 'acceptance-rerun.json'), JSON.stringify(summary, null, 2) + '\n')
    console.log('')
    console.log(`  合计 ${summary.total} 项：通过 ${summary.passed}，失败 ${summary.failed}`)
    console.log(`  明细已写入 docs/acceptance-rerun.json`)
    return summary.failed === 0
}

/* 假的 Control API：按指定状态码响应 /health */
function startControlApi(port, healthStatus) {
    return new Promise(resolve => {
        import('node:http').then(({ default: http }) => {
            const srv = http.createServer((req, res) => {
                if (req.url === '/health') {
                    res.writeHead(healthStatus, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify(healthStatus === 200 ? { ok: true, state: 'idle' } : { error: 'Unauthorized' }))
                }
                if (req.url === '/start' || req.url === '/stop') {
                    res.writeHead(202, { 'Content-Type': 'application/json' })
                    return res.end(JSON.stringify({ started: true }))
                }
                res.writeHead(404)
                res.end()
            })
            srv.listen(port, '127.0.0.1', () => resolve({ kill: () => srv.close() }))
        })
    })
}

try {
    const ok = await main()
    process.exitCode = ok ? 0 : 1
} catch (error) {
    console.error('验收脚本异常：', error)
    process.exitCode = 2
} finally {
    try {
        server?.kill()
    } catch {}
    await sleep(200)
    fs.rmSync(SANDBOX, { recursive: true, force: true })
}
