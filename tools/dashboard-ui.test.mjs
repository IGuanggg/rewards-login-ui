import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { trendSvg, createDashboard } from '../public/js/dashboard.js'
import { runIssues, createRunConsole } from '../public/js/run-console.js'

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
function dom(t) {
    const elements = new Map()
    const el = selector => {
        if (!elements.has(selector)) elements.set(selector, { dataset: {}, classList: { toggle() {} }, setAttribute() {}, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler }, querySelector: el })
        return elements.get(selector)
    }
    const previous = globalThis.document
    globalThis.document = { hidden: false, querySelector: el, querySelectorAll: () => [], addEventListener() {} }
    t.after(() => { globalThis.document = previous })
    return el
}
test('overview preserves unknown and zero, partial balance coverage and full account emails', async t => {
    const el = dom(t)
    let data = { today: '2026-10-26', timezone: 'Asia/Shanghai', todayPoints: 0, attention: 1,
        accounts: [{ email: 'a@example.invalid', savedSession: true, todayPoints: 0, balance: 0, balanceAt: null }, { email: '<other>@example.invalid', savedSession: false, todayPoints: null, balance: null }],
        schedule: { enabled: false }, trend: [], panelVersion: '2.1.0' }
    const dashboard = createDashboard({ api: async () => data, escapeHtml, onUnauthorized() {} })
    t.after(() => dashboard.stop())
    dashboard.open(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(el('#dash-points').textContent, 0)
    assert.equal(el('#dash-balance').textContent, 0)
    assert.equal(el('#dash-attention-metric').dataset.tone, 'attention')
    assert.equal(el('#dash-balance-note').textContent, '1/2 个账号已上报余额')
    assert.match(el('#dash-account-body').innerHTML, /&lt;other&gt;@example.invalid/)
    assert.match(el('#dash-account-body').innerHTML, /待确认/)
    data = { ...data, todayPoints: null, accounts: [], attention: 0 }
    await dashboard.refresh()
    assert.equal(el('#dash-points').textContent, '—')
    assert.equal(el('#dash-balance').textContent, '—')
    assert.equal(el('#dash-attention-metric').dataset.tone, 'neutral')
})
test('failed refresh retains data with an explicit stale warning, 401 ends the session', async t => {
    const el = dom(t)
    let unauthorized = false, status = 503
    el('#dash-points').textContent = 57
    const dashboard = createDashboard({ api: async () => { throw Object.assign(new Error('offline'), { status }) }, escapeHtml, onUnauthorized() { unauthorized = true } })
    t.after(() => dashboard.stop())
    dashboard.open(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(el('#dash-points').textContent, 57)
    assert.equal(el('#dash-error').hidden, false)
    assert.match(el('#dash-error').textContent, /上次数据/)
    status = 401; await dashboard.refresh()
    assert.equal(unauthorized, true)
})
test('trend shows real zero and gaps instead of filling missing days', () => {
    assert.match(trendSvg([]), /暂无积分记录/)
    const svg = trendSvg([{ day: '2026-10-24', points: 0 }, { day: '2026-10-25', points: null }, { day: '2026-10-26', points: 3 }])
    assert.match(svg, /2026-10-24：0 分/)
    assert.equal((svg.match(/<circle/g) || []).length, 2)
    assert.match(svg, /d="M[^L]+M/)
})
test('issues identify affected accounts and do not attribute earlier failures to a new run', () => {
    const startedAt = Date.now() - 60000
    const info = { state: 'idle', latest: { run: { startedAt, accounts: [{ email: 'a@example.invalid', error: 'Login required' }] }, tasks: [
        { account: 'a@example.invalid', state: 'failed', label: '登录' },
        { account: 'b@example.invalid', state: 'partial', label: '阅读', message: '未确认完成' },
        { account: 'c@example.invalid', state: 'skipped', label: '奖励' }
    ] } }
    assert.deepEqual(runIssues(info).map(x => x.account), ['a@example.invalid', 'b@example.invalid'])
    assert.deepEqual(runIssues({ ...info, state: 'running', startedAt: new Date().toISOString() }), [])
    assert.deepEqual(runIssues(null), [])
})
test('blocking action replaces disabled start, issue content is escaped and no duplicate records action appears', async t => {
    const el = dom(t)
    let info = { state: 'idle', readiness: { ready: false, action: 'accounts', accounts: 0 }, schedule: {} }
    const console = createRunConsole({ api: async () => info, escapeHtml, onUnauthorized() {}, onStart() {}, onAction() {} })
    t.after(() => console.stop())
    console.open(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(el('#btn-run-all').hidden, true)
    assert.equal(el('#run-next-action').className, 'primary-btn')
    info = { ...info, readiness: { ready: true, accounts: 1 }, latest: { run: { state: 'partial', startedAt: Date.now()-5000, endedAt: Date.now(), accounts: [{ email: '<img>@example.invalid', error: '<script>bad</script>' }] }, tasks: [] } }
    await console.refresh()
    assert.match(el('#run-issues-list').innerHTML, /&lt;img&gt;/)
    assert.doesNotMatch(el('#run-issues-list').innerHTML, /<script>/)
    assert.equal(el('#btn-run-records').hidden, true)
    assert.equal(el('#run-next-action').className, 'ghost-btn')
})
test('page uses functional button names and one component stylesheet plus dashboard layout', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
    assert.doesNotMatch(html, /liquid-btn|cdk\.css|stat-card|section-kicker/)
    assert.match(html, /\/css\/dashboard\.css/)
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1])
    assert.equal(new Set(ids).size, ids.length)
})
