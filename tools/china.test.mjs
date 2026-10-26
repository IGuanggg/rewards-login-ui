import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { chinaTopics, LOCAL_TOPICS, hotWords } from '../lib/china-queries.mjs'
import { ActivityStore } from '../lib/activity-store.mjs'
import { notificationView, saveNotifications, notifyRun } from '../lib/notifications.mjs'
import { readTaskSettings, writeTaskSettings, nextSchedule } from '../lib/task-settings.mjs'
import { waitMessage } from '../public/js/run-console.js'

function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-china-'))
    t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('rewards-china-')); fs.rmSync(dir, { recursive: true, force: true }) })
    return dir
}
test('domestic topics handle timeout, empty response, rate limit, deduplication and cached offline fallback', async () => {
    assert.deepEqual(hotWords({ data: [{ title: '<b>中文</b>' }, { title: '中文' }, { title: '' }] }), ['中文'])
    assert.deepEqual(hotWords({ data: [{ title: '中文\n词条' }] }), ['中文 词条'])
    let calls = 0, reports = []
    const fetcher = async () => { calls++; return new Response('{"code":403}', { status: 200 }) }
    assert.deepEqual(await chinaTopics({ fetcher, report: m => reports.push(m), now: 100 }), LOCAL_TOPICS)
    assert.equal(calls, 1)
    await chinaTopics({ fetcher, now: 200 }); assert.equal(calls, 1)
    assert.ok(reports.some(m => m.includes('限流')))
    calls = 0
    const words = await chinaTopics({ now: 1000000, fetcher: async () => { calls++; if (calls === 1) throw new Error('timeout'); return new Response(JSON.stringify({ data: [{ title: '今天的新闻' }] })) } })
    assert.equal(calls, 2); assert.ok(words.includes('今天的新闻')); assert.ok(words.includes(LOCAL_TOPICS[0]))
    const offline = await chinaTopics({ offline: true, fetcher: () => { throw new Error('must not request') } })
    assert.deepEqual(offline, LOCAL_TOPICS)
    calls = 0
    const oversized = await chinaTopics({ now: 4000000, fetcher: async () => { calls++; return new Response(' '.repeat(300000)) } })
    assert.equal(calls, 2); assert.deepEqual(oversized, LOCAL_TOPICS)
})

test('14-day overview separates calendar dates, preserves zero, and matches full emails', () => {
    const store = new ActivityStore(':memory:', { timezone: 'Asia/Shanghai' })
    try {
        const now = Date.parse('2026-10-26T04:00:00Z')
        const finish = (at, gained, email, balance) => {
            const id = store.begin(at)
            store.finish(id, 0, { finished: true, collected: gained, accounts: [{ email, success: true, collectedPoints: gained, finalPoints: balance }] }, { now: at + 1000 })
        }
        finish(now - 86400000, 99, 'same@example.com', 199)
        finish(now, 0, 'same@example.com', 199)
        finish(now + 2000, 5, 'same@example.net', 305)
        const data = store.overview(now + 5000)
        assert.equal(data.todayPoints, 5); assert.equal(data.todayRuns, 2)
        assert.equal(data.accounts.find(a => a.email === 'same@example.com').todayPoints, 0)
        assert.equal(data.accounts.find(a => a.email === 'same@example.net').balance, 305)
        assert.equal(data.trend.at(-2).points, 99); assert.equal(data.trend[0].points, null)
    } finally { store.close() }
})

test('notifications preserve secrets without returning them, validate channel changes and reject provider errors', async t => {
    const panel = path.join(scratch(t), 'panel.json'), secret = 'synthetic-notification-secret'
    saveNotifications(panel, { enabled: true, provider: 'pushplus', onlyProblems: false, token: secret })
    const view = saveNotifications(panel, { enabled: true, provider: 'pushplus', onlyProblems: true, token: '' })
    assert.equal(view.hasToken, true); assert.ok(!JSON.stringify(notificationView(panel)).includes(secret))
    assert.throws(() => saveNotifications(panel, { enabled: true, provider: 'serverchan', onlyProblems: true, token: '' }), /通知设置/)
    const done = { state: 'completed', day: '2026-10-26', points: 0, accounts: [{ email: 'private@example.invalid' }] }
    assert.deepEqual(await notifyRun(panel, done, { fetcher: () => { throw Error('unexpected') } }), { skipped: true })
    let sent
    await notifyRun(panel, { ...done, state: 'failed' }, { fetcher: async (url, options) => { sent = { url, body: options.body }; return new Response('{"code":200}') } })
    assert.ok(!sent.body.includes('private@example.invalid')); assert.equal(sent.url, 'https://www.pushplus.plus/send')
    await assert.rejects(notifyRun(panel, { ...done, state: 'failed' }, { fetcher: async () => new Response('{"code":500}') }), /未接受/)
})

test('domestic setting requires actual adapter and preserves unrelated config', t => {
    const dir = scratch(t), panel = path.join(dir, 'panel.json')
    const config = { workers: { doDailyCheckIn: true }, searchSettings: { queryEngines: ['local'], searchDelay: { min: '30sec', max: '1min' } }, accountDelay: { min: '0sec', max: '1sec' }, webhook: { secret: 'preserved' }, headless: true }
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config))
    const input = { workers: config.workers, queryMode: 'china', searchDelay: { min: 120, max: 240 }, accountDelay: { min: 0, max: 1 }, readDelay: { min: 60, max: 120 }, stopOnWarning: true, skipNonPointTasks: true }
    assert.throws(() => writeTaskSettings(dir, panel, input), /适配/)
    fs.mkdirSync(path.join(dir, 'scripts/api'), { recursive: true }); fs.writeFileSync(path.join(dir, 'scripts/api/panel-china-version.json'), '{}')
    const result = writeTaskSettings(dir, panel, input)
    assert.equal(result.queryMode, 'china'); assert.deepEqual(result.readDelay, input.readDelay)
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'config.json'))).webhook.secret, 'preserved')
    assert.equal(readTaskSettings(dir, panel).chinaSupported, true)
})

test('compiled upstream integration actually executes China adapter and fails closed on drift', async t => {
    const dir = scratch(t)
    fs.mkdirSync(path.join(dir, 'scripts/api'), { recursive: true }); fs.mkdirSync(path.join(dir, 'dist/functions'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'scripts/api/server.js'), 'function request(){\n        // index\n}\n')
    const queryFile = path.join(dir, 'dist/functions/QueryEngine.js')
    fs.writeFileSync(queryFile, 'exports.QueryCore = class { constructor(bot) { this.bot = bot } async queryManager(options = {}) { return ["old"] } getLocalQueryList() { return ["old"] } };')
    fs.mkdirSync(path.join(dir, 'dist/util'), { recursive: true }); fs.writeFileSync(path.join(dir, 'dist/util/Utils.js'), 'exports.Util = class { async wait(time) {} }')
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../docker/prepare-upstream.mjs', import.meta.url)), dir], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const previous = process.env.PANEL_QUERY_MODE
    try {
        process.env.PANEL_QUERY_MODE = 'china-local'
        const { QueryCore } = await import(pathToFileURL(queryFile).href)
        const bot = { logger: { info() {} }, utils: { shuffleArray: a => a.reverse() } }
        const core = new QueryCore(bot)
        assert.deepEqual(await core.queryManager(), LOCAL_TOPICS); assert.deepEqual(core.getLocalQueryList(), LOCAL_TOPICS)
        process.env.PANEL_QUERY_MODE = 'existing'; assert.deepEqual(await core.queryManager(), ['old'])
        const { Util } = await import(pathToFileURL(path.join(dir, 'dist/util/Utils.js')).href)
        const messages = [], originalLog = console.log
        console.log = value => messages.push(value)
        try { await new Util().wait(30000); await new Util().wait(100) } finally { console.log = originalLog }
        assert.equal(messages.length, 1); assert.match(messages[0], /^__PANEL_WAIT__/)
    } finally { if (previous == null) delete process.env.PANEL_QUERY_MODE; else process.env.PANEL_QUERY_MODE = previous }
    const again = spawnSync(process.execPath, [fileURLToPath(new URL('../docker/prepare-upstream.mjs', import.meta.url)), dir], { encoding: 'utf8' })
    assert.notEqual(again.status, 0)
})

test('waiting countdown uses reported start and next schedule follows Shanghai midnight', () => {
    const now = Date.parse('2026-10-25T16:00:30Z')
    assert.match(waitMessage({ seconds: 90, sinceTs: now - 30000 }, now), /1 分 0 秒/)
    assert.match(waitMessage({ seconds: 5, sinceTs: now - 6000 }, now), /已结束/)
    assert.equal(nextSchedule({ enabled: true, runAt: '00:01', timezone: 'Asia/Shanghai' }, now), '2026-10-25T16:01:00.000Z')
    assert.equal(nextSchedule({ enabled: false }, now), null)
})
