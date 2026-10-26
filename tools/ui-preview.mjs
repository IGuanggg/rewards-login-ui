/** Isolated UI preview. All accounts, points and run actions are synthetic.
 * node tools/ui-preview.mjs → http://127.0.0.1:4186/__preview?width=1280
 * Scenarios: partial, completed, running, empty, offline. Never starts the bot.
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../public/', import.meta.url))
const port = Number(process.env.PREVIEW_PORT || 4186)
const now = Date.now(), day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now)
const states = new Map()
const schedule = { enabled: true, runAt: '08:30', timezone: 'Asia/Shanghai', supported: true, nextAt: now + 86400000 }
const accounts = ['daily@example.invalid', 'backup@example.invalid'].map((email, i) => ({ index: i + 1, email, hasPassword: true, sessions: { mobile: { cookies: 18, updatedAt: now - 3600000 }, desktop: { cookies: 15, updatedAt: now - 3600000 } } }))
function fixture(name) {
    const mode = states.get(name) || name
    const empty = mode === 'empty', running = mode === 'running', problem = mode === 'partial'
    const points = empty ? null : 57
    const run = { id: 'preview-run', day, startedAt: now - 720000, endedAt: running ? null : now - 60000, state: running ? 'running' : problem ? 'partial' : mode === 'cancelled' ? 'cancelled' : 'completed', points, revision: 1,
        currentAccount: accounts[1].email, accounts: accounts.map((a, i) => ({ email: a.email, collectedPoints: i ? null : 57, finalPoints: i ? null : 6732, ...(problem && i ? { error: '登录会话已失效，请重新登录。' } : {}) })) }
    const tasks = accounts.map((a, i) => ({ account: a.email, platform: 'DESKTOP', label: i ? '账号登录' : 'Bing 搜索', state: running && i ? 'running' : problem && i ? 'failed' : 'completed', startedAt: now - 700000, updatedAt: now - 60000, points: i ? null : 57, message: problem && i ? '登录会话已失效，请重新登录。' : '搜索任务已完成。' }))
    return { mode, empty, running, problem, points, run, tasks }
}
const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`)
    const referer = new URL(req.headers.referer || url.href)
    const name = referer.searchParams.get('scenario') || url.searchParams.get('scenario') || 'partial'
    const f = fixture(name)
    const json = data => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
    if (url.pathname === '/__preview') {
        const width = Math.max(320, Math.min(1600, Number(url.searchParams.get('width')) || 1280))
        const height = Math.max(600, Math.min(1800, Number(url.searchParams.get('height')) || 1000))
        const scenario = ['partial', 'completed', 'running', 'empty', 'offline'].includes(name) ? name : 'partial'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(`<body style="margin:0;background:#e8e8ec;font:14px system-ui"><header style="padding:12px">隔离预览 · 虚构数据 · ${width}px · ${scenario}</header><iframe title="控制台预览" src="/?scenario=${scenario}" style="display:block;border:0;width:${width}px;height:${height}px;margin:auto"></iframe></body>`)
    }
    if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/auth/state') return json({ authRequired: true, authenticated: true })
        if (url.pathname === '/api/state') return json({ authRequired: true, botDir: '/preview/Microsoft-Rewards-Script', control: { status: 'online', detail: '预览接口' } })
        if (url.pathname === '/api/preflight') return json({ ready: true, checks: [], blocking: [] })
        if (url.pathname === '/api/accounts') return json({ accounts: f.empty ? [] : accounts, envExists: true, nextIndex: 3 })
        if (url.pathname === '/api/jobs') return json({ jobs: [] })
        if (url.pathname === '/api/control/status') return json({ state: f.mode === 'offline' ? 'unknown' : f.running ? 'running' : 'idle', control: { status: f.mode === 'offline' ? 'offline' : 'online' }, readiness: { ready: !f.empty, accounts: f.empty ? 0 : 2, action: f.empty ? 'accounts' : null }, schedule, latest: f.empty ? null : { run: f.run, tasks: f.tasks }, startedAt: f.running ? new Date(f.run.startedAt).toISOString() : null, run: { currentAccount: accounts[1].email, pendingDelay: f.running ? { seconds: 900, sinceTs: now, nextEmail: accounts[0].email } : null } })
        if (url.pathname === '/api/control/start' || url.pathname === '/api/control/stop') { states.set(name, url.pathname.endsWith('start') ? 'running' : 'cancelled'); return json({ ok: true }) }
        if (url.pathname === '/api/dashboard') return json({ today: day, timezone: 'Asia/Shanghai', todayPoints: f.points, todayRuns: f.empty ? 0 : 1, attention: f.problem ? 1 : 0, accounts: f.empty ? [] : accounts.map((a, i) => ({ email: a.email, savedSession: true, todayPoints: i ? null : 57, balance: i ? null : 6732, balanceAt: i ? null : now - 60000 })), trend: Array.from({ length: 14 }, (_, i) => ({ day: new Date(now - (13-i)*86400000).toISOString().slice(0,10), points: f.empty || i < 3 ? null : [57,60,54,63,57,60,57,54,60,57,57][i-3], runs: f.empty || i<3 ? 0 : 1 })), schedule, queryMode: 'china', panelVersion: '2.1.0', upstreamVersion: '4.3.2' })
        if (url.pathname === '/api/activity') return json({ day, today: day, timezone: 'Asia/Shanghai', retentionDays: 30, summary: { runs: f.empty ? 0 : 1, tasks: f.empty ? 0 : 2, points: f.points, attention: f.problem ? 1 : 0 }, runs: f.empty ? [] : [f.run] })
        if (url.pathname === '/api/activity/run') return json({ run: f.run, tasks: f.tasks })
        if (url.pathname === '/api/activity/logs') return json({ logs: [], nextBefore: null })
        if (url.pathname === '/api/task-settings') return json({ workers: [{ key: "doDailyCheckIn", label: "每日签入", enabled: true }, { key: "doReadToEarn", label: "阅读", enabled: true }, { key: "doSearch", label: "搜索", enabled: true }], searchDelay: { min: 120, max: 240 }, readDelay: { min: 60, max: 120 }, accountDelay: { min: 0, max: 1 }, queryMode: 'china', chinaSupported: true, schedule, schedulingSupported: true })
        if (url.pathname === '/api/notifications') return json({ enabled: false, supported: true, provider: 'pushplus' })
        if (req.headers.accept?.includes('text/event-stream')) { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); return res.write(': preview\n\n') }
        return json({ ok: true })
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' })[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    fs.createReadStream(file).pipe(res)
})
server.listen(port, '127.0.0.1', () => console.log(`Isolated preview: http://127.0.0.1:${port}/__preview?width=1280`))
