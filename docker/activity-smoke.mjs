import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createRunRecorder } from '../lib/run-recorder.mjs'
import { ActivityStore } from '../lib/activity-store.mjs'

// Synthetic log emitter + the real pinned upstream parser. No Rewards process,
// account credentials, network requests, or production database are used.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rewards-activity-smoke-'))
const oldPath = process.env.PANEL_ACTIVITY_DB
process.env.PANEL_ACTIVITY_DB = path.join(dir, 'activity.db')
let store
try {
    const recorder = await createRunRecorder('/opt/rewards', path.join(dir, 'panel.json'))
    const lines = [
        ['MAIN', 'RUN-START', 'Starting Microsoft Rewards Script | v4.3.2 | Accounts: 1 | Clusters: 1'],
        ['MAIN', 'ACCOUNT-START', 'Starting account: sample@example.invalid | geoLocale: auto | locale: en-US'],
        ['MOBILE', 'DAILY-CHECK-IN', 'Starting Daily Check-In | currentBalance=100'],
        ['MOBILE', 'DAILY-CHECK-IN', 'Completed Daily Check-In | type=103 | pointsGained=5 | currentBalance=105'],
        ['MOBILE', 'READ-TO-EARN', 'Starting Read to Earn | note=阅读记录验证 | currentBalance=105'],
        ['MOBILE', 'READ-TO-EARN', 'Read article 1/2 | pointsGained=5 | currentBalance=110'],
        ['MOBILE', 'READ-TO-EARN', 'Read article 2/2 | pointsGained=5 | currentBalance=115'],
        ['MOBILE', 'READ-TO-EARN', 'Completed Read to Earn | articlesRead=2 | pointsGained=10 | currentBalance=115'],
        ['MOBILE', 'SEARCH-BING', 'Starting Bing searches | currentBalance=115'],
        ['MOBILE', 'SEARCH-BING', 'pointsGained=3 | currentBalance=118 | query="test"'],
        ['MOBILE', 'SEARCH-BING', 'Completed Bing searches | pointsGained=3 | currentBalance=118 | previousBalance=115 | searches=1'],
        ['MAIN', 'ACCOUNT-END', 'Completed account: sample@example.invalid | pointsGained=18 | previousBalance=100 | currentBalance=118 | durationSeconds=10'],
        ['MAIN', 'RUN-END', 'Completed all accounts | accountsProcessed=1 | pointsGained=18 | previousBalance=100 | currentBalance=118 | runtimeMinutes=0.2']
    ].map(([platform, title, message]) => `[2026-10-26 12:00:00] [sample] [INFO] ${platform} [${title}] ${message}`).join('\n')
    const emitter = `const b=Buffer.from(${JSON.stringify(lines)}); let i=0; const t=setInterval(()=>{process.stdout.write(b.subarray(i,i+7));i+=7;if(i>=b.length)clearInterval(t)},1)`
    const child = spawn(process.execPath, ['-e', emitter], { stdio: ['ignore', 'pipe', 'pipe'] })
    recorder.attach(child)
    const [code] = await once(child, 'close')
    recorder.finish(code, false)
    store = new ActivityStore(process.env.PANEL_ACTIVITY_DB)
    const day = store.day()
    assert.equal(day.runs.length, 1)
    assert.equal(day.runs[0].state, 'completed')
    assert.equal(day.summary.points, 18)
    const detail = store.detail(day.runs[0].id)
    assert.equal(detail.tasks.length, 3)
    assert.equal(detail.tasks.find(task => task.category === 'READ-TO-EARN').points, 10)
    assert.ok(store.logs(day.runs[0].id).logs.some(log => log.message.includes('阅读记录验证')))
    console.log('\nPASS durable activity journal, real upstream parser, task points, and split UTF-8 output')
    const fixture = path.join(dir, 'synthetic-bot')
    fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true })
    fs.mkdirSync(path.join(fixture, 'scripts/api'), { recursive: true })
    fs.writeFileSync(path.join(fixture, 'package.json'), '{"type":"module"}')
    fs.writeFileSync(path.join(fixture, 'config.json'), '{"sessionPath":"sessions","searchSettings":{}}')
    fs.writeFileSync(path.join(fixture, 'dist/index.js'), emitter)
    fs.copyFileSync('/opt/rewards/scripts/api/logParser.js', path.join(fixture, 'scripts/api/logParser.js'))
    const workerFile = path.join(dir, 'worker-activity.db')
    const worker = spawn(process.execPath, [fileURLToPath(new URL('./worker.mjs', import.meta.url)), 'bot'], {
        env: { ...process.env, BOT_DIR: fixture, PANEL_ACTIVITY_DB: workerFile }, stdio: 'ignore'
    })
    assert.equal((await once(worker, 'close'))[0], 0)
    const workerStore = new ActivityStore(workerFile)
    try {
        assert.equal(workerStore.day().summary.points, 18)
        assert.equal(workerStore.day().runs[0].state, 'completed')
        assert.equal(workerStore.detail(workerStore.day().runs[0].id).tasks.length, 3)
    } finally { workerStore.close() }
    console.log('PASS actual worker lifecycle records synthetic output without running Rewards')
} finally {
    store?.close()
    if (oldPath === undefined) delete process.env.PANEL_ACTIVITY_DB
    else process.env.PANEL_ACTIVITY_DB = oldPath
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dir).startsWith('rewards-activity-smoke-'))
    fs.rmSync(dir, { recursive: true, force: true })
}
