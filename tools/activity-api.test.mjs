import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ActivityStore } from '../lib/activity-store.mjs'

test('activity routes require authentication and persist records across panel restarts', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-api-test-'))
    const config = path.join(dir, 'panel.json')
    const token = 'synthetic-activity-panel-token'
    fs.writeFileSync(config, JSON.stringify({ panelToken: token }))
    const store = new ActivityStore(path.join(dir, 'activity.db'))
    const id = store.begin()
    store.append(id, { title: 'DAILY-CHECK-IN', message: 'Completed Daily Check-In | pointsGained=5 | currentBalance=105', platform: 'MOBILE', account: 'sample@example.invalid', level: 'info' })
    store.finish(id, 0, { collected: 5, finished: true, accounts: [{ email: 'sample@example.invalid', success: true, collectedPoints: 5 }] })
    store.close()
    const reservation = net.createServer()
    reservation.listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const port = reservation.address().port
    await new Promise(resolve => reservation.close(resolve))
    const base = `http://127.0.0.1:${port}`
    let child
    async function stop() {
        if (child?.exitCode === null) { child.kill(); await once(child, 'exit') }
    }
    t.after(async () => {
        await stop()
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
        assert.ok(path.basename(dir).startsWith('activity-api-test-'))
        fs.rmSync(dir, { recursive: true, force: true })
    })
    async function start() {
        child = spawn(process.execPath, [fileURLToPath(new URL('../server.js', import.meta.url))], {
            env: { ...process.env, PANEL_CONFIG: config, PANEL_TOKEN: token, PANEL_PORT: String(port), PANEL_HOST: '127.0.0.1', PANEL_NO_AUTH: '0' },
            stdio: 'ignore', windowsHide: true
        })
        for (let i = 0; i < 60; i++) {
            try { if ((await fetch(base + '/api/auth/state')).ok) return } catch {}
            await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('Test panel did not start')
    }
    async function authenticate() {
        const response = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
        assert.equal(response.status, 200)
        return response.headers.get('set-cookie').split(';')[0]
    }
    await start()
    for (const url of ['/api/activity', `/api/activity/run?id=${id}`, `/api/activity/logs?id=${id}`]) {
        assert.equal((await fetch(base + url)).status, 401)
    }
    let cookie = await authenticate()
    const get = url => fetch(base + url, { headers: { Cookie: cookie } })
    let day = await (await get('/api/activity')).json()
    assert.equal(day.summary.points, 5)
    assert.equal(day.runs[0].id, id)
    const detail = await (await get(`/api/activity/run?id=${id}`)).json()
    assert.equal(detail.tasks[0].state, 'completed')
    assert.equal((await (await get(`/api/activity/logs?id=${id}`)).json()).logs.length, 1)
    assert.equal((await get('/api/activity?day=2026-02-31')).status, 422)
    assert.equal((await get(`/api/activity/logs?id=${id}&before=bad`)).status, 422)
    assert.equal((await get('/api/activity/run?id=missing')).status, 404)
    await stop()
    await start()
    assert.equal((await get('/api/activity')).status, 401)
    cookie = await authenticate()
    day = await (await get('/api/activity')).json()
    assert.equal(day.summary.points, 5)
    assert.equal(day.runs[0].id, id)
})
