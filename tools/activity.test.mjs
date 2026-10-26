import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ActivityStore, dayAt, validDay, classifyTask, redactLog } from '../lib/activity-store.mjs'

const account = 'sample@example.invalid'
const summary = { collected: 18, finished: true, accounts: [{ email: account, success: true, initialPoints: 100, finalPoints: 118, collectedPoints: 18 }] }
const entry = (title, message, extra = {}) => ({ title, message, account, platform: 'MOBILE', level: 'info', ...extra })

function store(t, options) {
    const instance = new ActivityStore(':memory:', options)
    t.after(() => instance.close())
    return instance
}

test('dates follow the server timezone and reject invalid calendar dates', () => {
    assert.equal(dayAt(Date.parse('2026-10-26T16:20:00Z'), 'Asia/Shanghai'), '2026-10-27')
    assert.equal(dayAt(Date.parse('2026-10-26T16:20:00Z'), 'UTC'), '2026-10-26')
    assert.equal(validDay('2026-02-31'), false)
    assert.equal(validDay('2026-10-26'), true)
    assert.equal(validDay('../data'), false)
})

test('task states distinguish processing, confirmed completion, and prior completion', () => {
    assert.equal(classifyTask(entry('DAILY-SET', 'Finished processing "Daily Set" items')).status, 'processed')
    assert.equal(classifyTask(entry('DAILY-SET', 'All "Daily Set" items have already been completed')).status, 'already_done')
    assert.equal(classifyTask(entry('READ-TO-EARN', 'Skipping: App access token not available')).status, 'skipped')
    assert.equal(classifyTask(entry('READ-TO-EARN', 'Read article 1/2 | pointsGained=5 | currentBalance=105')).points, null)
    assert.equal(classifyTask(entry('READ-TO-EARN', 'Completed Read to Earn | pointsGained=10 | currentBalance=110')).points, 10)
    assert.equal(classifyTask(entry('DAILY-CHECK-IN', 'Daily Check-In completed but no points gained | pointsGained=0 | currentBalance=100')).points, 0)
    assert.equal(classifyTask(entry('BROWSER', 'Starting browser')), null)
})

test('per-task summaries do not double-count per-item point updates', t => {
    const db = store(t)
    const id = db.begin()
    db.append(id, entry('READ-TO-EARN', 'Starting Read to Earn'))
    db.append(id, entry('READ-TO-EARN', 'Read article 1/2 | pointsGained=5 | currentBalance=105'))
    db.append(id, entry('READ-TO-EARN', 'Read article 2/2 | pointsGained=5 | currentBalance=110'))
    db.append(id, entry('READ-TO-EARN', 'Completed Read to Earn | pointsGained=10 | currentBalance=110'))
    db.finish(id, 0, summary)
    const result = db.detail(id)
    assert.equal(result.tasks.length, 1)
    assert.equal(result.tasks[0].points, 10)
    assert.equal(result.tasks[0].state, 'completed')
    assert.equal(result.run.points, 18)
    assert.equal(db.day().summary.points, 18)
})

test('an error followed by a processing-finished line remains partial', t => {
    const db = store(t)
    const id = db.begin()
    db.append(id, entry('PUNCHCARD', 'Error solving quest', { level: 'error' }))
    db.append(id, entry('PUNCHCARD', 'Finished processing quests'))
    db.finish(id, 0, summary)
    assert.equal(db.detail(id).tasks[0].state, 'partial')
    assert.equal(db.detail(id).run.state, 'partial')
    assert.equal(db.day().summary.attention, 1)
})

test('zero exit without completion evidence cannot mark unfinished tasks complete', t => {
    const db = store(t)
    const id = db.begin()
    db.append(id, entry('SEARCH-BING', 'Starting Bing searches'))
    db.finish(id, 0, { collected: 0, finished: false, accounts: [] })
    const result = db.detail(id)
    assert.equal(result.run.state, 'partial')
    assert.equal(result.tasks[0].state, 'incomplete')
    assert.equal(result.run.points, null)
    assert.equal(db.day().summary.points, null)
})

test('cancellation and stale heartbeats produce explicit unfinished states', t => {
    const db = store(t)
    const first = db.begin()
    db.append(first, entry('SEARCH-BING', 'Starting Bing searches'))
    db.finish(first, 143, {}, { cancelled: true })
    assert.equal(db.detail(first).tasks[0].state, 'cancelled')
    const second = db.begin()
    db.append(second, entry('DAILY-SET', 'Started solving "Daily Set" items'))
    db.db.prepare('UPDATE activity_runs SET updated_at=? WHERE id=?').run(Date.now() - 100000, second)
    db.day()
    assert.equal(db.detail(second).run.state, 'interrupted')
    assert.equal(db.detail(second).tasks[0].state, 'incomplete')
})

test('logs paginate without duplicates and raw-output retention preserves task summaries', t => {
    const db = store(t, { maxEvents: 200 })
    const id = db.begin()
    db.append(id, entry('DAILY-CHECK-IN', 'Completed Daily Check-In | pointsGained=5 | currentBalance=105'))
    for (let i = 0; i < 298; i++) db.append(id, entry('BROWSER', `line-${i}`))
    const first = db.logs(id)
    assert.equal(first.logs.length, 200)
    assert.ok(first.nextBefore)
    const second = db.logs(id, { before: first.nextBefore })
    assert.equal(second.logs.length, 99)
    assert.equal(new Set([...first.logs, ...second.logs].map(log => log.id)).size, 299)
    db.append(id, entry('BROWSER', 'trigger-retention'))
    assert.equal(db.logs(id).logs.length, 200)
    assert.equal(db.logs(id).nextBefore, null)
    assert.equal(db.detail(id).tasks[0].points, 5)
})

test('records survive reopening; old days are pruned with dependent logs', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-test-'))
    const file = path.join(dir, 'activity.db')
    t.after(() => {
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
        assert.ok(path.basename(dir).startsWith('activity-test-'))
        fs.rmSync(dir, { recursive: true, force: true })
    })
    let db = new ActivityStore(file)
    const old = db.begin(Date.now() - 40 * 86400000)
    db.append(old, entry('DAILY-SET', 'Finished processing items'))
    db.finish(old, 0, summary)
    const current = db.begin()
    db.append(current, entry('DAILY-CHECK-IN', 'Completed Daily Check-In | pointsGained=5 | currentBalance=105'))
    db.finish(current, 0, summary)
    db.close()
    db = new ActivityStore(file)
    assert.equal(db.detail(current).run.points, 18)
    assert.throws(() => db.detail(old), /未找到/)
    assert.equal(db.db.prepare('SELECT count(*) AS n FROM activity_events WHERE run_id=?').get(old).n, 0)
    db.close()
})

test('tokens, passwords, cookie headers, and known secrets are hidden before storage', t => {
    const input = 'password="do not store" | Authorization: Bearer private-token | Cookie: session=abcdef | url=https://example.invalid/?code=secret-code&token=secret-token | my-known-secret'
    const clean = redactLog(input, ['my-known-secret'])
    for (const secret of ['do not store', 'private-token', 'abcdef', 'secret-code', 'secret-token', 'my-known-secret']) assert.ok(!clean.includes(secret))
    const db = store(t, { secrets: ['my-known-secret'] })
    const id = db.begin()
    db.append(id, entry('BROWSER', input))
    assert.equal(db.logs(id).logs[0].message, clean)
})
