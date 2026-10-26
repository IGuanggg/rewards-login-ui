import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createDesktopProxy } from '../lib/desktop-proxy.mjs'
import { lowMemoryConfig } from '../docker/runtime.mjs'
import { refreshAccountEnv } from '../docker/accounts-env.mjs'

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-docker-test-'))
    t.after(() => {
        const parent = path.resolve(os.tmpdir()) + path.sep
        assert.ok(path.resolve(dir).startsWith(parent) && path.basename(dir).startsWith('panel-docker-test-'))
        fs.rmSync(dir, { recursive: true, force: true })
    })
    return dir
}

test('low-memory settings preserve user workers and force sequential searches', () => {
    const original = { clusters: 8, headless: false, sessionPath: 'old', workers: { doMobileSearch: true }, searchSettings: { parallelSearching: true, clusterSearch: true, maxBonusSearches: 30 } }
    const config = lowMemoryConfig(original, '/data/sessions')
    assert.equal(config.clusters, 1)
    assert.equal(config.headless, true)
    assert.equal(config.sessionPath, '/data/sessions')
    assert.equal(config.searchSettings.parallelSearching, false)
    assert.equal(config.searchSettings.clusterSearch, false)
    assert.equal(config.searchSettings.maxBonusSearches, 30)
    assert.deepEqual(config.workers, original.workers)
    assert.equal(original.clusters, 8)
})

test('editing accounts replaces cached accounts without changing API credentials', t => {
    const dir = scratch(t)
    const saved = { ...process.env }
    t.after(() => {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
        Object.assign(process.env, saved)
    })
    process.env.ACCOUNT_99_EMAIL = 'removed@example.com'
    process.env.API_TOKEN = 'keep-internal-token'
    fs.writeFileSync(path.join(dir, '.env'), 'ACCOUNT_1_EMAIL=new@example.com\nACCOUNT_1_PASSWORD="a # b = c"\nAPI_TOKEN=untrusted\n')
    refreshAccountEnv(dir)
    assert.equal(process.env.ACCOUNT_1_EMAIL, 'new@example.com')
    assert.equal(process.env.ACCOUNT_1_PASSWORD, 'a # b = c')
    assert.equal(process.env.ACCOUNT_99_EMAIL, undefined)
    assert.equal(process.env.API_TOKEN, 'keep-internal-token')
    fs.writeFileSync(path.join(dir, '.env'), '# all removed\n')
    refreshAccountEnv(dir)
    assert.equal(process.env.ACCOUNT_1_EMAIL, undefined)
})

test('upstream integration fails closed if the expected source changes', t => {
    const dir = scratch(t)
    fs.mkdirSync(path.join(dir, 'scripts/api'), { recursive: true })
    const file = path.join(dir, 'scripts/api/server.js')
    fs.writeFileSync(file, 'changed upstream')
    const script = new URL('../docker/prepare-upstream.mjs', import.meta.url)
    const bad = spawnSync(process.execPath, [fileURLToPath(script), dir], { encoding: 'utf8' })
    assert.notEqual(bad.status, 0)
    assert.equal(fs.readFileSync(file, 'utf8'), 'changed upstream')
    fs.writeFileSync(file, 'async function request() {\n    try {\n        // index\n    } catch {}\n}\n')
    const good = spawnSync(process.execPath, [fileURLToPath(script), dir], { encoding: 'utf8' })
    assert.equal(good.status, 0, good.stderr)
    assert.match(fs.readFileSync(file, 'utf8'), /refreshAccountEnv\(projectRoot\)/)
})

test('desktop proxy protects assets, WebSockets, and disconnects revoked sessions', async t => {
    let authenticated = true
    let active = true
    let receivedHeaders
    const backendSockets = new Set()
    const backend = http.createServer((req, res) => {
        receivedHeaders = req.headers
        res.setHeader('Content-Type', 'text/javascript')
        res.end(req.url)
    })
    backend.on('connection', socket => { backendSockets.add(socket); socket.once('close', () => backendSockets.delete(socket)) })
    backend.on('upgrade', (req, socket) => {
        receivedHeaders = req.headers
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
        socket.on('data', bytes => socket.write(bytes))
    })
    backend.listen(0, '127.0.0.1')
    await once(backend, 'listening')
    const proxy = createDesktopProxy({ authenticated: () => authenticated, active: () => active, port: backend.address().port })
    const panel = http.createServer((req, res) => proxy.handle(req, res, new URL(req.url, 'http://test')))
    panel.on('upgrade', proxy.upgrade)
    panel.listen(0, '127.0.0.1')
    await once(panel, 'listening')
    const port = panel.address().port
    const origin = `http://127.0.0.1:${port}`
    t.after(() => {
        proxy.close()
        for (const socket of backendSockets) socket.destroy()
        panel.closeAllConnections(); panel.close()
        backend.closeAllConnections(); backend.close()
    })
    authenticated = false
    assert.equal((await fetch(`${origin}/desktop/vnc.html`)).status, 401)
    authenticated = true; active = false
    assert.equal((await fetch(`${origin}/desktop/vnc.html`)).status, 409)
    active = true
    const asset = await fetch(`${origin}/desktop/app/ui.js?test=1`, { headers: { Cookie: 'panel_session=secret', Authorization: 'Bearer secret' } })
    assert.equal(asset.status, 200)
    assert.equal(await asset.text(), '/app/ui.js?test=1')
    assert.equal(receivedHeaders.cookie, undefined)
    assert.equal(receivedHeaders.authorization, undefined)

    async function upgrade({ requestOrigin = origin, url = '/desktop/websockify' } = {}) {
        const socket = net.createConnection({ host: '127.0.0.1', port })
        socket.setTimeout(3000, () => socket.destroy(new Error('upgrade timed out')))
        await once(socket, 'connect')
        const data = once(socket, 'data')
        socket.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${requestOrigin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGVzdC1wcm94eS1rZXk=\r\nCookie: panel_session=secret\r\n\r\n`)
        const [bytes] = await data
        return { socket, status: bytes.toString() }
    }
    authenticated = false
    let denied = await upgrade()
    assert.match(denied.status, /401/); denied.socket.destroy()
    authenticated = true
    denied = await upgrade({ requestOrigin: 'https://other.example' })
    assert.match(denied.status, /403/); denied.socket.destroy()
    active = false
    denied = await upgrade()
    assert.match(denied.status, /409/); denied.socket.destroy()
    active = true
    const allowed = await upgrade()
    assert.match(allowed.status, /101/)
    assert.equal(receivedHeaders.cookie, undefined)
    const bytes = once(allowed.socket, 'data')
    allowed.socket.write('test-tunnel')
    assert.equal((await bytes)[0].toString(), 'test-tunnel')
    const closed = once(allowed.socket, 'close')
    authenticated = false
    proxy.close()
    await closed
})

test('Docker panel blocks login during a run and reserves concurrent start requests', async t => {
    const dir = scratch(t)
    const bot = path.join(dir, 'bot')
    fs.mkdirSync(path.join(bot, 'scripts/main'), { recursive: true })
    fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({ name: 'microsoft-rewards-script' }))
    fs.writeFileSync(path.join(bot, 'scripts/main/manualLogin.js'), 'throw new Error("Must not launch during run")')
    fs.writeFileSync(path.join(bot, 'scripts/utils.js'), '')
    fs.writeFileSync(path.join(bot, '.env'), 'ACCOUNT_1_EMAIL=test@example.com\nACCOUNT_1_PASSWORD=synthetic\n')
    fs.writeFileSync(path.join(bot, 'config.json'), JSON.stringify({ sessionPath: 'sessions' }))
    fs.mkdirSync(path.join(bot, 'dist'), { recursive: true })
    fs.writeFileSync(path.join(bot, 'dist/index.js'), '')
    for (const dep of ['patchright', 'fingerprint-generator', 'fingerprint-injector', 'otpauth', 'ghost-cursor-playwright-port']) fs.mkdirSync(path.join(bot, 'node_modules', dep), { recursive: true })
    const browsers = path.join(dir, 'browsers')
    fs.mkdirSync(path.join(browsers, 'chromium-1/chrome-win64'), { recursive: true })
    fs.writeFileSync(path.join(browsers, 'chromium-1/chrome-win64/chrome.exe'), 'synthetic file, never launched')
    let remoteState = 'running'
    let starts = 0
    const control = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json')
        if (req.url === '/health') return res.end(JSON.stringify({ state: remoteState }))
        if (req.url === '/start') {
            starts++
            return setTimeout(() => { res.writeHead(202); res.end('{}') }, 100)
        }
        res.writeHead(404); res.end('{}')
    })
    control.listen(0, '127.0.0.1')
    await once(control, 'listening')
    t.after(() => { control.closeAllConnections(); control.close() })
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    const config = path.join(dir, 'panel.json')
    fs.writeFileSync(config, JSON.stringify({ botDir: bot, panelToken: 'docker-test-token', controlApi: `http://127.0.0.1:${control.address().port}` }))
    const child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
        env: { ...process.env, PANEL_PORT: String(port), PANEL_HOST: '127.0.0.1', PANEL_CONFIG: config, PANEL_TOKEN: 'docker-test-token', PANEL_NO_AUTH: '0', PANEL_REMOTE_DESKTOP: '1', BOT_DIR: bot, PLAYWRIGHT_BROWSERS_PATH: browsers },
        stdio: 'ignore', windowsHide: true
    })
    t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit') } })
    const base = `http://127.0.0.1:${port}`
    let ready = false
    for (let i = 0; i < 60; i++) {
        try { ready = (await fetch(`${base}/api/auth/state`)).ok } catch {}
        if (ready) break
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(ready, 'isolated panel started')
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'docker-test-token' }) })
    const cookie = login.headers.get('set-cookie').split(';')[0]
    const post = (url, body) => fetch(base + url, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await post('/api/login/start', { email: 'test@example.com' })).status, 409)
    assert.equal((await post('/api/control/start', {})).status, 409)
    remoteState = 'idle'
    const responses = await Promise.all([post('/api/control/start', {}), post('/api/control/start', {})])
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 409])
    assert.equal(starts, 1)
})
