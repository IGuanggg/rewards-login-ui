import test from 'node:test'
import assert from 'node:assert/strict'
import { runView, elapsed, createRunConsole } from '../public/js/run-console.js'

const ready = () => ({ state: 'idle', readiness: { ready: true, accounts: 2 }, schedule: { enabled: false }, run: {}, latest: null })

test('run console gives actionable account, login, environment and offline states', () => {
    assert.equal(runView(ready()).startDisabled, false)
    for (const action of ['accounts', 'login', 'settings']) {
        const view = runView({ ...ready(), readiness: { ready: false, action, error: 'synthetic preparation problem' } })
        assert.equal(view.startDisabled, true)
        assert.equal(view.action, action)
        assert.match(view.description, /synthetic preparation/)
    }
    assert.equal(runView({ ...ready(), state: 'unknown' }).action, 'refresh')
    const auth = runView({ ...ready(), authorization: { email: 'sample@example.invalid', desktopUrl: '/desktop/vnc.html' } })
    assert.equal(auth.startDisabled, true)
    assert.equal(auth.action, 'desktop')
})

test('running state uses real tasks, keeps unknown points unknown and ignores earlier run', () => {
    const startedAt = Date.now() - 65000
    const latest = { run: { startedAt, points: 5 }, tasks: [{ state: 'running', label: 'Bing 搜索', updatedAt: Date.now() }] }
    let view = runView({ ...ready(), state: 'running', startedAt: new Date(startedAt).toISOString(), latest })
    assert.equal(view.active, true)
    assert.equal(view.task, 'Bing 搜索')
    assert.equal(view.points, 5)
    assert.equal(view.startDisabled, true)
    assert.equal(view.stopDisabled, false)
    view = runView({ ...ready(), state: 'starting', startedAt: new Date().toISOString(), latest })
    assert.equal(view.points, null)
    assert.match(view.task, /初始化/)
    assert.equal(runView(ready(), { pending: 'stop' }).stopDisabled, true)
    assert.equal(elapsed(startedAt, startedAt + 65000), '1 分 5 秒')
})

test('last result survives reload and failed login offers the affected account', () => {
    const info = { ...ready(), latest: { run: { id: 'synthetic', state: 'partial', startedAt: Date.now() - 30000, endedAt: Date.now(), points: null, accounts: [{ email: 'sample@example.invalid', error: 'Login verification required' }] }, tasks: [] } }
    let view = runView(info)
    assert.equal(view.action, 'login')
    assert.equal(view.email, 'sample@example.invalid')
    assert.equal(view.points, null)
    info.latest.run.state = 'completed'; info.latest.run.points = 0
    view = runView(info)
    assert.equal(view.tone, 'success')
    assert.equal(view.points, 0)
    view = runView({ ...ready(), lastExit: { code: 75, at: new Date().toISOString() } })
    assert.equal(view.action, 'settings')
    assert.match(view.description, /75/)
})

test('UI immediately disables duplicate starts and calls the actual stop endpoint', async t => {
    const elements = new Map()
    const el = selector => {
        if (!elements.has(selector)) elements.set(selector, { dataset: {}, classList: { toggle() {} }, setAttribute() {}, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler }, querySelector: el })
        return elements.get(selector)
    }
    const originalDocument = globalThis.document
    globalThis.document = { hidden: false, querySelector: el, querySelectorAll: () => [], addEventListener() {} }
    t.after(() => { globalThis.document = originalDocument })
    let state = ready(), releaseStart, starts = 0, stops = 0
    const request = async (url, options) => {
        if (url.endsWith('/status')) return state
        if (url.endsWith('/start')) {
            starts++; assert.deepEqual(options.body, { payload: { accountIndex: 3 } })
            await new Promise(resolve => { releaseStart = resolve })
            state = { ...state, state: 'running', startedAt: new Date().toISOString() }
        }
        if (url.endsWith('/stop')) { stops++; state = { ...state, state: 'idle' } }
        return {}
    }
    const console = createRunConsole({ api: request, onUnauthorized() { assert.fail('unexpected auth failure') }, onStart() {}, onAction() {} })
    t.after(() => console.stop())
    console.open()
    await new Promise(resolve => setImmediate(resolve))
    const first = console.start(3)
    assert.equal(el('#btn-run-all').disabled, true)
    await console.start(3)
    assert.equal(starts, 1)
    releaseStart(); await first
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(el('#btn-stop-run').hidden, false)
    await el('#btn-stop-run').handlers.click()
    assert.equal(stops, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(el('#btn-stop-run').hidden, true)
})
