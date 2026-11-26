import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ActivityStore } from '../lib/activity-store.mjs'
import { readTaskSettings, writeTaskSettings, readSchedule, nextSchedule, scheduleDate, scheduleMarkerFile } from '../lib/task-settings.mjs'
import { DatabaseSync } from 'node:sqlite'

function fixture(t, registerCleanup = true) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-run-test-'))
    const cleanup = () => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('panel-run-test-')); fs.rmSync(dir, { recursive: true, force: true }) }
    if (registerCleanup) t.after(cleanup)
    const original = { headless: true, clusters: 1, sessionPath: 'sessions', workers: { doDailyCheckIn: true, doDesktopSearch: false },
        searchSettings: { searchDelay: { min: '30sec', max: '1min' }, queryEngines: ['wikipedia'], parallelSearching: false },
        accountDelay: { min: '1min', max: '3min' }, contintueOnBotWarning: false, skipNonPointTasks: true,
        webhook: { telegram: { botToken: 'synthetic-secret' } } }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(original))
    fs.writeFileSync(path.join(dir, 'config.example.json'), JSON.stringify(original))
    const panel = path.join(dir, 'panel.json')
    return { dir, panel, original, cleanup }
}
const bodyFor = data => ({ ...data, workers: Object.fromEntries(data.workers.map(worker => [worker.key, worker.enabled])), schedule: { enabled: false, runAt: '09:00' } })

test('daily scheduling follows configured timezone and persisted same-day marker', () => {
    const schedule = { enabled: true, runAt: '00:05', timezone: 'Asia/Shanghai' }
    const now = Date.parse('2026-10-25T16:05:30Z')
    assert.equal(scheduleDate(schedule, now), '2026-10-26')
    assert.equal(scheduleDate(schedule, now, '2026-10-26'), null)
    assert.equal(scheduleDate({ ...schedule, enabled: false }, now), null)
    assert.equal(scheduleDate(schedule, now + 60000), null)
})

test('task settings validate before writing, preserve credentials and persist schedule overrides', t => {
    const { dir, panel, original } = fixture(t)
    const data = readTaskSettings(dir, panel)
    assert.deepEqual(data.searchDelay, { min: 30, max: 60 })
    const body = bodyFor(data)
    assert.throws(() => writeTaskSettings(dir, panel, { ...body, workers: { injection: true } }, { scheduling: true }), /任务/)
    assert.throws(() => writeTaskSettings(dir, panel, { ...body, searchDelay: { min: 30, max: 15 } }, { scheduling: true }), /间隔/)
    assert.throws(() => writeTaskSettings(dir, panel, { ...body, schedule: { enabled: true, runAt: '25:00' } }, { scheduling: true }), /定时/)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))), original)
    const next = writeTaskSettings(dir, panel, { ...body, queryMode: 'local', schedule: { enabled: true, runAt: '08:25' } }, { scheduling: true })
    assert.equal(next.queryMode, 'local')
    assert.equal(readSchedule(panel).runAt, '08:25')
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json')))
    assert.deepEqual(saved.webhook, original.webhook)
    assert.equal(saved.headless, true); assert.equal(saved.clusters, 1); assert.equal(saved.searchSettings.parallelSearching, false)
    const reset = writeTaskSettings(dir, panel, { ...body, queryMode: 'default' }, { scheduling: true })
    assert.equal(reset.queryMode, 'existing')
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).searchSettings.queryEngines, ['wikipedia'])

    // Switching from china to existing must update query-mode.json instead of snapping back
    fs.mkdirSync(path.join(dir, 'scripts/api'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts/api/panel-china-version.json'), '{"version":1}')
    const chinaSaved = writeTaskSettings(dir, panel, { ...body, queryMode: 'china' }, { scheduling: true })
    assert.equal(chinaSaved.queryMode, 'china')
    const backFromChina = writeTaskSettings(dir, panel, { ...body, queryMode: 'existing' }, { scheduling: true })
    assert.notEqual(backFromChina.queryMode, 'china')

    // Changing schedule runAt clears today's marker; unchanged runAt preserves marker and shifts nextSchedule to next day
    writeTaskSettings(dir, panel, { ...body, schedule: { enabled: true, runAt: '08:25' } }, { scheduling: true })
    const marker = scheduleMarkerFile(panel)
    const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(Date.now())
    fs.writeFileSync(marker, todayLocal)
    const shifted = nextSchedule({ enabled: true, runAt: '23:59', timezone: 'Asia/Shanghai' }, Date.parse(`${todayLocal}T01:00:00+08:00`), todayLocal)
    assert.notEqual(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(Date.parse(shifted)), todayLocal)
    writeTaskSettings(dir, panel, { ...body, schedule: { enabled: true, runAt: '08:25' } }, { scheduling: true })
    assert.equal(fs.existsSync(marker), true, 'unchanged runAt preserves same-day marker')
    writeTaskSettings(dir, panel, { ...body, schedule: { enabled: true, runAt: '14:30' } }, { scheduling: true })
    assert.equal(fs.existsSync(marker), false, 'changed runAt clears same-day marker so rescheduled run executes')
})

test('authenticated UI API starts selected accounts, reports real state and stops; unsafe or unready requests do not start', async t => {
    const { dir, panel, cleanup } = fixture(t, false)
    let child, control
    t.after(async () => {
        if (child?.exitCode === null) { const closed = once(child, 'exit'); child.kill(); await closed }
        control?.closeAllConnections(); control?.close()
        cleanup()
    })
    fs.mkdirSync(path.join(dir, 'scripts/main'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts/main/manualLogin.js'), '')
    fs.writeFileSync(path.join(dir, 'scripts/utils.js'), '')
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'microsoft-rewards-script' }))
    fs.writeFileSync(path.join(dir, '.env'), 'ACCOUNT_3_EMAIL=sample@example.invalid\nACCOUNT_3_PASSWORD=synthetic\n')
    fs.mkdirSync(path.join(dir, 'dist')); fs.writeFileSync(path.join(dir, 'dist/index.js'), '')
    for (const dep of ['patchright', 'fingerprint-generator', 'fingerprint-injector', 'otpauth', 'ghost-cursor-playwright-port']) fs.mkdirSync(path.join(dir, 'node_modules', dep), { recursive: true })
    const browsers = path.join(dir, 'browsers')
    fs.mkdirSync(path.join(browsers, 'chromium-1/chrome-win64'), { recursive: true })
    fs.writeFileSync(path.join(browsers, 'chromium-1/chrome-win64/chrome.exe'), 'never executed')
    const store = new ActivityStore(path.join(dir, 'activity.db'))
    const id = store.begin()
    store.finish(id, 0, { finished: true, collected: 0, accounts: [{ email: 'sample@example.invalid', success: true }] }); store.close()
    let remoteState = 'idle', starts = 0, stops = 0, selected
    control = http.createServer(async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/health') return res.end(JSON.stringify({ state: remoteState }))
        if (req.url === '/status') return res.end(JSON.stringify({ state: remoteState, startedAt: remoteState === 'running' ? new Date().toISOString() : null, command: 'must not expose', run: { accountsTotal: 1, accounts: [], live: { currentAccount: 'sample@example.invalid' } } }))
        if (req.url === '/start') {
            let raw = ''; for await (const chunk of req) raw += chunk
            selected = JSON.parse(raw); starts++; remoteState = 'running'; res.writeHead(202); return res.end('{}')
        }
        if (req.url === '/stop') { stops++; remoteState = 'idle'; res.writeHead(202); return res.end('{}') }
        res.writeHead(404); res.end('{}')
    })
    control.listen(0, '127.0.0.1'); await once(control, 'listening')
    const reservation = net.createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening')
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve))
    const token = 'synthetic-panel-token'
    fs.writeFileSync(panel, JSON.stringify({ panelToken: token, botDir: dir, controlApi: `http://127.0.0.1:${control.address().port}` }))
    child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], { env: { ...process.env, PANEL_CONFIG: panel, PANEL_TOKEN: token, PANEL_NO_AUTH: '0', PANEL_PORT: String(port), PANEL_HOST: '127.0.0.1', PANEL_REMOTE_DESKTOP: '1', PLAYWRIGHT_BROWSERS_PATH: browsers }, stdio: 'ignore', windowsHide: true })
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i++) { try { ready = (await fetch(base + '/api/auth/state')).ok } catch {} if (ready) break; await new Promise(resolve => setTimeout(resolve, 50)) }
    assert.ok(ready)
    for (const route of ['/api/control/status', '/api/task-settings', '/api/dashboard', '/api/notifications']) assert.equal((await fetch(base + route)).status, 401)
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const request = (route, body, method = 'POST') => fetch(base + route, { method: body ? method : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    let status = await (await request('/api/control/status')).json()
    assert.equal(status.state, 'idle'); assert.equal(status.readiness.ready, true); assert.equal(status.latest.run.id, id)
    assert.equal(status.command, undefined)
    assert.equal((await request('/api/control/start', { payload: { args: ['untrusted'] } })).status, 422)
    assert.equal((await request('/api/control/start', { payload: { accountIndex: 999 } })).status, 422)
    assert.equal(starts, 0)
    const settings = await (await request('/api/task-settings')).json()
    const overview = await (await request('/api/dashboard')).json()
    assert.equal(overview.accounts.length, 1)
    assert.equal(overview.todayPoints, 0)
    assert.equal(overview.accounts[0].balance, null)
    const notice = await request('/api/notifications', { enabled: false, provider: 'pushplus', onlyProblems: true, token: 'synthetic-key' }, 'PUT')
    assert.equal(notice.status, 200); assert.equal((await notice.json()).hasToken, true)
    assert.equal(JSON.stringify(await (await request('/api/notifications')).json()).includes('synthetic-key'), false)
    const next = bodyFor(settings)
    assert.equal((await request('/api/task-settings', next, 'PUT')).status, 200)
    assert.equal((await request('/api/control/start', { payload: { accountIndex: 3 } })).status, 202)
    assert.deepEqual(selected, { accountIndex: 3 })
    status = await (await request('/api/control/status')).json()
    assert.equal(status.state, 'running'); assert.equal(status.run.currentAccount, 'sample@example.invalid')
    assert.equal((await request('/api/control/start', {})).status, 409)
    const busyTaskRes = await request('/api/task-settings', next, 'PUT')
    assert.equal(busyTaskRes.status, 409)
    assert.match((await busyTaskRes.json()).error, /修改签到设置/)
    assert.equal((await request('/api/accounts', { index: 3, email: 'sample@example.invalid' }, 'POST')).status, 409)
    assert.equal((await fetch(base + '/api/accounts/3', { method: 'DELETE', headers: { Cookie: cookie } })).status, 409)
    assert.equal(starts, 1)
    assert.equal((await request('/api/control/stop', {})).status, 202); assert.equal(stops, 1)

    // Passwordless account with only mobile session fails desktop readiness & reports partialSession on dashboard
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
        headless: true, clusters: 1, sessionPath: 'sessions',
        workers: { doDailyCheckIn: true, doDesktopSearch: true },
        searchSettings: { searchDelay: { min: '30sec', max: '1min' }, queryEngines: ['wikipedia'], parallelSearching: false },
        accountDelay: { min: '1min', max: '3min' }, contintueOnBotWarning: false, skipNonPointTasks: true
    }))
    fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
    const sdb = new DatabaseSync(path.join(dir, 'sessions/sessions.db'))
    sdb.exec('CREATE TABLE IF NOT EXISTS sessions (email TEXT NOT NULL, platform TEXT NOT NULL, storage_state TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (email, platform))')
    sdb.prepare('INSERT INTO sessions (email, platform, storage_state, updated_at) VALUES (?,?,?,?)').run('sample@example.invalid', 'mobile', JSON.stringify({ cookies: [{ name: 'c', value: 'v' }] }), Date.now())
    sdb.close()
    // Clear password via API removePassword flag
    const clearedAcc = await request('/api/accounts', { index: 3, email: 'sample@example.invalid', removePassword: true }, 'POST')
    assert.equal(clearedAcc.status, 200)
    assert.equal((await clearedAcc.json()).accounts[0].hasPassword, false)
    const dashPartial = await (await request('/api/dashboard')).json()
    assert.equal(dashPartial.accounts[0].savedSession, false)
    assert.equal(dashPartial.accounts[0].partialSession, true)
    assert.equal(dashPartial.accounts[0].mobileSaved, true)
    assert.equal(dashPartial.accounts[0].desktopSaved, false)
    const blocked = await request('/api/control/start', {})
    assert.equal(blocked.status, 422)
    const blockedBody = await blocked.json()
    assert.equal(blockedBody.action, 'login')
    assert.match(blockedBody.error, /电脑端/)
    assert.equal(starts, 1)

    // Password change reports envManaged and invalidates other session cookies
    const secondLogin = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
    const otherCookie = secondLogin.headers.get('set-cookie').split(';')[0]
    const pwRes = await fetch(base + '/api/auth/password', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'new-token-123456' }) })
    assert.equal(pwRes.status, 200)
    const pwBody = await pwRes.json()
    assert.equal(pwBody.envManaged, true)
    const refreshedCookie = pwRes.headers.get('set-cookie').split(';')[0]
    assert.equal((await fetch(base + '/api/state', { headers: { Cookie: otherCookie } })).status, 401, 'old cookie from another device must be invalidated')
    const stateAfterPw = await fetch(base + '/api/state', { headers: { Cookie: refreshedCookie } })
    assert.equal(stateAfterPw.status, 200)
    assert.equal((await stateAfterPw.json()).passwordManagedByEnv, true)

    // Malformed percent encoding returns 400 instead of 500
    assert.equal((await fetch(base + '/%E0%A4%A')).status, 400)
})
