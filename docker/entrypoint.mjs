import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { LOCK_FILE, lowMemoryConfig, migrateConfigToTemplate, writeJson, start, stopAll, waitForPort } from './runtime.mjs'
import { ActivityStore, activityFile } from '../lib/activity-store.mjs'
import { readSchedule, scheduleDate, scheduleMarkerFile } from '../lib/task-settings.mjs'
import { inspectCookieHealth, readSessionHealthMap } from '../lib/session-health.mjs'
import { notifySessionAlerts } from '../lib/notifications.mjs'

process.umask(0o077)
if (['1', 'true', 'yes', 'on'].includes(String(process.env.PANEL_NO_AUTH).toLowerCase())) throw new Error('Docker 远程授权要求启用面板访问密码')
const root = process.env.BOT_DIR || '/opt/rewards'
const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const data = '/data'
fs.mkdirSync(path.join(data, 'sessions'), { recursive: true })
const accountFile = path.join(data, 'accounts.env')
if (!fs.existsSync(accountFile)) fs.writeFileSync(accountFile, '# Accounts managed by Rewards panel\n', { mode: 0o600 })

const panelFile = process.env.PANEL_CONFIG || path.join(data, 'panel.json')
const isV5 = fs.existsSync(path.join(root, 'dist/control-api/server.js'))
const botConfig = path.join(data, 'bot-config.json')
const templatePath = path.join(root, 'config.example.json')
const freshConfig = !fs.existsSync(botConfig)
const templateConfig = fs.existsSync(templatePath) ? JSON.parse(fs.readFileSync(templatePath, 'utf8')) : null
const rawExisting = freshConfig ? structuredClone(templateConfig || {}) : JSON.parse(fs.readFileSync(botConfig, 'utf8'))

const queryModePath = path.join(path.dirname(panelFile), 'query-mode.json')
let activeQueryMode = 'china'
if (fs.existsSync(queryModePath)) {
    try { activeQueryMode = JSON.parse(fs.readFileSync(queryModePath, 'utf8'))?.mode || 'china' } catch {}
} else {
    activeQueryMode = ['china', 'china-local', 'existing'].includes(rawExisting.panelQueryMode) ? rawExisting.panelQueryMode : 'china'
    writeJson(queryModePath, { mode: activeQueryMode })
}

let initial = rawExisting
if (isV5) {
    // 兼容旧版拼写并按 v5 模板清洗废弃键，避免 v5 严格 Zod 校验失败
    if (rawExisting.contintueOnBotWarning !== undefined && rawExisting.continueOnBotWarning === undefined) {
        rawExisting.continueOnBotWarning = rawExisting.contintueOnBotWarning
    }
    if (templateConfig) initial = migrateConfigToTemplate(rawExisting, templateConfig)
    if (freshConfig || !['api', 'browser'].includes(rawExisting.rewardsMode)) initial.rewardsMode = 'api'
    if (typeof rawExisting.ensureStreakProtection !== 'boolean') initial.ensureStreakProtection = true
    delete initial.panelQueryMode
} else {
    initial.panelQueryMode = activeQueryMode
}

if (['china', 'china-local'].includes(activeQueryMode)) {
    initial.searchSettings = { ...initial.searchSettings, queryEngines: ['local'] }
    initial.searchOnBingLocalQueries = true
}

writeJson(botConfig, lowMemoryConfig(initial, '/data/sessions'))
for (const [name, target] of [['.env', accountFile], ['config.json', botConfig]]) {
    const file = path.join(root, name)
    if (fs.existsSync(file) || fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file)
    fs.symlinkSync(target, file)
}

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
const apiScript = isV5 ? path.join(root, 'dist/control-api/server.js') : path.join(root, 'scripts/api/server.js')
const api = start(process.execPath, [apiScript], {
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
        let lastSessionCheckDay = ''
        const marker = scheduleMarkerFile(panelFile)
        const checkLocalSessionExpiry = async () => {
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Asia/Shanghai' }).format(Date.now())
            if (today === lastSessionCheckDay) return
            lastSessionCheckDay = today
            try {
                const dbPath = path.join(data, 'sessions', 'sessions.db')
                if (!fs.existsSync(dbPath)) return
                const activeEmails = new Set(
                    (fs.existsSync(accountFile) ? fs.readFileSync(accountFile, 'utf8') : '')
                        .split(/\r?\n/)
                        .map(line => /^\s*ACCOUNT_\d+_EMAIL\s*=\s*(.+)$/.exec(line)?.[1]?.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
                        .filter(Boolean)
                )
                const overlays = readSessionHealthMap(panelFile)
                const sdb = new DatabaseSync(dbPath, { readOnly: true })
                const alerts = []
                try {
                    for (const row of sdb.prepare('SELECT email, platform, storage_state, updated_at FROM sessions').all()) {
                        const key = String(row.email || '').toLowerCase()
                        if (activeEmails.size && !activeEmails.has(key)) continue
                        const overlay = overlays[key]?.[row.platform] || null
                        const health = inspectCookieHealth(row.storage_state, { updatedAt: Number(row.updated_at) || null, overlay })
                        if (['invalid', 'expired', 'expiring'].includes(health.status)) {
                            alerts.push({ email: row.email, platform: row.platform, status: health.status, daysLeft: health.daysLeft, reason: health.reason })
                        }
                    }
                } finally { sdb.close() }
                if (alerts.length) {
                    const res = await notifySessionAlerts(panelFile, alerts, { source: 'schedule' })
                    if (res?.sent) console.log(`[session-health] sent ${res.count} cookie expiry alert(s)`)
                }
            } catch (error) { console.error(`[session-health] ${error.message}`) }
        }
        void checkLocalSessionExpiry()
        scheduleTimer = setInterval(async () => {
            if (stopping || scheduling) return
            scheduling = true
            try {
                await checkLocalSessionExpiry()
                const schedule = readSchedule(panelFile)
                const date = scheduleDate(schedule, Date.now(), fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : '')
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
