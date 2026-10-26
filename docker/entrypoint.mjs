import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LOCK_FILE, lowMemoryConfig, writeJson, start, stopAll, waitForPort } from './runtime.mjs'
import { ActivityStore, activityFile } from '../lib/activity-store.mjs'
import { readSchedule, scheduleDate } from '../lib/task-settings.mjs'

process.umask(0o077)
if (['1', 'true', 'yes', 'on'].includes(String(process.env.PANEL_NO_AUTH).toLowerCase())) throw new Error('Docker 远程授权要求启用面板访问密码')
const root = process.env.BOT_DIR || '/opt/rewards'
const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = '/data'
fs.mkdirSync(path.join(data, 'sessions'), { recursive: true })
const accountFile = path.join(data, 'accounts.env')
if (!fs.existsSync(accountFile)) fs.writeFileSync(accountFile, '# Accounts managed by Rewards panel\n', { mode: 0o600 })
const botConfig = path.join(data, 'bot-config.json')
const sourceConfig = fs.existsSync(botConfig) ? botConfig : path.join(root, 'config.example.json')
const initial = JSON.parse(fs.readFileSync(sourceConfig, 'utf8'))
initial.panelQueryMode ||= 'china'
if (['china', 'china-local'].includes(initial.panelQueryMode)) {
    initial.searchSettings.queryEngines = ['local']
    initial.searchOnBingLocalQueries = true
}
writeJson(botConfig, lowMemoryConfig(initial, '/data/sessions'))
for (const [name, target] of [['.env', accountFile], ['config.json', botConfig]]) {
    const file = path.join(root, name)
    if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file)
    fs.symlinkSync(target, file)
}
const panelFile = process.env.PANEL_CONFIG || path.join(data, 'panel.json')
const activity = new ActivityStore(activityFile(panelFile))
activity.interruptRunning()
activity.prune()
activity.close()
const panel = fs.existsSync(panelFile) ? JSON.parse(fs.readFileSync(panelFile, 'utf8')) : {}
panel.botDir = root
panel.controlApi = 'http://127.0.0.1:3010'
panel.controlToken ||= randomBytes(24).toString('base64url')
writeJson(panelFile, panel)

const env = { ...process.env, PANEL_CONFIG: panelFile, PANEL_REMOTE_DESKTOP: '1' }
const api = start(process.execPath, [path.join(root, 'scripts/api/server.js')], {
    cwd: root,
    env: {
        ...env, API_HOST: '127.0.0.1', API_PORT: '3010', API_TOKEN: panel.controlToken,
        API_LOG_BUFFER: '400', API_RUN_HISTORY: '10',
        API_ALLOW_ENV_OVERRIDES: 'false', API_ALLOW_CONFIG_WRITE: 'false', API_ALLOW_SCHEDULE_WRITE: 'false',
        API_RUN_COMMAND: '/usr/bin/flock',
        API_RUN_ARGS: JSON.stringify(['--nonblock', '--no-fork', '--conflict-exit-code', '75', LOCK_FILE, process.execPath, path.join(panelRoot, 'docker/worker.mjs'), 'bot'])
    }
})
const children = [api]
let stopping = false
let scheduleTimer
async function shutdown(code) {
    if (stopping) return
    stopping = true
    clearInterval(scheduleTimer)
    await stopAll([...children].reverse(), 18000)
    process.exitCode = code
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void shutdown(0) })

try {
    await waitForPort(3010, api)
    if (!stopping) children.push(start(process.execPath, [path.join(panelRoot, 'server.js')], { cwd: panelRoot, env }))
    {
        let scheduling = false
        const marker = path.join(data, 'last-scheduled-date')
        scheduleTimer = setInterval(async () => {
            if (stopping || scheduling) return
            scheduling = true
            try {
                const schedule = readSchedule(panelFile)
                const date = scheduleDate(schedule, Date.now(), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '')
                if (!date) return
                const headers = { Authorization: `Bearer ${panel.controlToken}`, 'Content-Type': 'application/json' }
                const health = await fetch('http://127.0.0.1:3010/health', { headers, signal: AbortSignal.timeout(3000) }).then(r => r.json())
                if (health.state !== 'idle' || spawnSync('flock', ['--nonblock', LOCK_FILE, 'true']).status !== 0) {
                    fs.writeFileSync(marker, date)
                    writeJson(path.join(data, 'schedule-state.json'), { day: date, at: Date.now(), state: 'skipped', reason: '到点时浏览器忙碌，今日定时已跳过' })
                    console.log(`[schedule] ${date} skipped: browser busy`)
                    return
                }
                const response = await fetch('http://127.0.0.1:3010/start', { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(5000) })
                if (response.ok) {
                    fs.writeFileSync(marker, date)
                    writeJson(path.join(data, 'schedule-state.json'), { day: date, at: Date.now(), state: 'started', reason: '已按计划启动签到' })
                } else writeJson(path.join(data, 'schedule-state.json'), { day: date, at: Date.now(), state: 'failed', reason: '定时启动请求失败，请检查签到服务' })
            } catch (error) { console.error(`[schedule] ${error.message}`) }
            finally { scheduling = false }
        }, 15000)
        const schedule = readSchedule(panelFile)
        console.log(`[schedule] ${schedule.enabled ? `Daily at ${schedule.runAt}` : 'Disabled'} (${schedule.timezone}); editable in panel, skip while busy`)
    }
    const code = await Promise.race(children.map(child => child.done))
    if (!stopping) await shutdown(code || 1)
} catch (error) {
    console.error(`[runtime] ${error.message}`)
    await shutdown(1)
}
